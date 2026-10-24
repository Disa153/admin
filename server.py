#!/usr/bin/env python3
"""
Админка клуба — бэкенд между телефоном и Gizmo Web API.

Запуск:  python server.py
Потом с телефона (в Tailscale или в той же Wi-Fi):  http://<адрес этого ПК>:8787

Что умеет (и ничего больше — телефон не может послать в Gizmo произвольную команду):
  • вход по логину/паролю оператора Gizmo (пароль хранится только в памяти, на время сессии);
  • список ПК со статусом: свободен / занят / не в сети / включается;
  • процессы ПК: только пользовательские программы, сгруппированы, с иконками и загрузкой ЦП;
  • завершить программу (системные и клиент Gizmo защищены);
  • перезагрузить / выключить ПК (shutdown), включить (Wake-on-LAN), сообщение на экран (msg);
  • статус смены (только просмотр) и остатки товаров (только чтение — для сверки).

Каждое действие пишется в actions.log.
Только стандартная библиотека Python 3.8+.
"""
import base64
import ipaddress
import json
import os
import re
import secrets
import socket
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = os.path.dirname(os.path.abspath(__file__))
APP_DIR = os.path.join(HERE, "app")
LOG_PATH = os.path.join(HERE, "actions.log")


# ───────────────────────── настройки ─────────────────────────

def load_env(path):
    env = {}
    if os.path.exists(path):
        with open(path, encoding="utf-8-sig") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    env[k.strip()] = v.strip().strip('"').strip("'")
    return env


ENV = load_env(os.path.join(HERE, ".env"))


def cfg(key, default):
    return ENV.get(key) or os.environ.get(key) or default


GIZMO_URL = cfg("GIZMO_URL", "http://localhost:8080").rstrip("/")
LISTEN_HOST = cfg("LISTEN_HOST", "0.0.0.0")
LISTEN_PORT = int(cfg("LISTEN_PORT", "8787"))
WOL_BROADCAST = cfg("WOL_BROADCAST", "255.255.255.255")
SESSION_HOURS = float(cfg("SESSION_HOURS", "12"))
CLUB_NAME = cfg("CLUB_NAME", "Зал 1")
# Как показывать сообщение на ПК: toast — тихая плашка сверху; box — окно с кнопкой ОК; msg — msg.exe
MESSAGE_MODE = cfg("MESSAGE_MODE", "toast").lower()
# В чём Gizmo считает «amount» при начислении времени: minutes или seconds (проверить на стенде)
TECH_TIME_UNIT = cfg("TECH_TIME_UNIT", "minutes").lower()


# ───────────────────────── Gizmo API ─────────────────────────

class GizmoError(Exception):
    def __init__(self, msg, status=502, offline=False):
        super().__init__(msg)
        self.status = status
        self.offline = offline


_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


class Gizmo:
    def __init__(self, user, password):
        self.auth = "Basic " + base64.b64encode(f"{user}:{password}".encode("utf-8")).decode("ascii")

    def call(self, method, path, params=None, timeout=15):
        url = GIZMO_URL + path
        if params:
            url += "?" + urllib.parse.urlencode(params)
        req = urllib.request.Request(url, method=method,
                                     headers={"Authorization": self.auth, "Accept": "application/json"})
        if method in ("PUT", "POST"):
            req.data = b""
        try:
            with _OPENER.open(req, timeout=timeout) as r:
                raw = r.read().decode("utf-8-sig", errors="replace")
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", errors="replace")
            if e.code == 401:
                raise GizmoError("Неверный логин или пароль оператора", 401)
            msg = body
            try:
                msg = json.loads(body).get("message") or body
            except Exception:
                pass
            raise GizmoError(str(msg)[:300], 502, offline="dispatcher" in body.lower())
        except (urllib.error.URLError, socket.timeout, TimeoutError) as e:
            raise GizmoError(f"Сервер Gizmo недоступен ({getattr(e, 'reason', e)})", 503)
        try:
            data = json.loads(raw) if raw else None
        except json.JSONDecodeError:
            return raw
        if isinstance(data, dict) and "result" in data and ("isError" in data or "httpStatusCode" in data):
            if data.get("isError"):
                m = str(data.get("message") or "Ошибка Gizmo")
                raise GizmoError(m[:300], 502, offline="dispatcher" in m.lower())
            return data["result"]
        return data

    def get(self, path, params=None, timeout=15):
        return self.call("GET", path, params, timeout)


# ───────────────────────── сессии и защита входа ─────────────────────────

SESSIONS = {}          # token -> {"user","pass","expires"}
FAILS = {}             # ip -> [count, until]
LOCK = threading.Lock()


def new_session(user, password):
    token = secrets.token_urlsafe(32)
    with LOCK:
        SESSIONS[token] = {"user": user, "pass": password,
                           "expires": time.time() + SESSION_HOURS * 3600}
    return token


def get_session(token):
    with LOCK:
        s = SESSIONS.get(token)
        if s and s["expires"] < time.time():
            SESSIONS.pop(token, None)
            s = None
    return s


def login_blocked(ip):
    with LOCK:
        c = FAILS.get(ip)
        return bool(c and c[1] > time.time())


def login_failed(ip):
    with LOCK:
        c = FAILS.setdefault(ip, [0, 0])
        c[0] += 1
        if c[0] >= 5:
            c[0], c[1] = 0, time.time() + 300  # 5 ошибок — пауза 5 минут


def audit(user, action, target="", detail=""):
    line = json.dumps({"time": datetime.now().isoformat(timespec="seconds"), "operator": user,
                       "action": action, "target": target, "detail": detail}, ensure_ascii=False)
    with LOCK:
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    print("  [действие]", line)


# ───────────────────────── статусы ПК ─────────────────────────

STATUS_CACHE = {}      # hostId -> (time, online, maintenance)
WAKE_REQUESTS = {}     # hostId -> time
USER_NAMES = {}        # userId -> name
POOL = ThreadPoolExecutor(max_workers=16)


def parse_dt(s):
    """Время Gizmo: '2026-10-23T11:58:04.3699951' (локальное)."""
    if not s or s.startswith("0001"):
        return None
    s = s.rstrip("Z")
    s = re.sub(r"(\.\d{6})\d+", r"\1", s)
    s = re.sub(r"[+-]\d\d:\d\d$", "", s)
    try:
        return datetime.fromisoformat(s)
    except ValueError:
        return None


def probe_online(gz, host_id):
    """Подключён ли клиент: лёгкий запрос режима обслуживания; ошибка «Dispatcher» = не в сети."""
    now = time.time()
    c = STATUS_CACHE.get(host_id)
    if c and now - c[0] < 8:
        return c[1], c[2]
    online, maint = False, False
    try:
        maint = bool(gz.get(f"/api/hostcomputers/{host_id}/maintenance", timeout=6))
        online = True
    except GizmoError as e:
        if not e.offline:
            # запасной путь: список процессов (тяжелее, но надёжно показывает связь)
            try:
                gz.get(f"/api/hostcomputers/{host_id}/process", timeout=8)
                online = True
            except GizmoError:
                online = False
    STATUS_CACHE[host_id] = (now, online, maint)
    return online, maint


def user_name(gz, uid):
    if uid in USER_NAMES:
        return USER_NAMES[uid]
    name = f"Гость #{uid}"
    try:
        u = gz.get(f"/api/users/{uid}", timeout=5) or {}
        name = u.get("username") or name
    except GizmoError:
        pass
    USER_NAMES[uid] = name
    return name


def list_hosts(gz):
    hosts = [h for h in all_hosts(gz, 0) if not h.get("isDeleted")]
    try:
        sessions = gz.get("/api/usersessions/active") or []
    except GizmoError:
        sessions = []
    by_host = {s.get("hostId"): s for s in sessions}
    probes = {h["id"]: POOL.submit(probe_online, gz, h["id"]) for h in hosts}
    now = datetime.now()
    out = []
    for h in sorted(hosts, key=lambda x: (x.get("number") or 0, x.get("name") or "")):
        hid = h["id"]
        online, maint = probes[hid].result()
        sess = by_host.get(hid)
        if sess:
            status = "busy"
            WAKE_REQUESTS.pop(hid, None)
        elif online:
            status = "free"
            WAKE_REQUESTS.pop(hid, None)
        elif hid in WAKE_REQUESTS and time.time() - WAKE_REQUESTS[hid] < 240:
            status = "boot"
        else:
            status = "off"
        item = {"id": hid, "number": h.get("number"), "name": h.get("name") or h.get("hostname"),
                "hostname": h.get("hostname"), "hasMac": bool(h.get("macAddress")),
                "status": status, "maintenance": maint}
        if sess:
            start = parse_dt(sess.get("createdTime"))
            item["sessionMinutes"] = max(0, int((now - start).total_seconds() // 60)) if start else None
            item["user"] = user_name(gz, sess.get("userId"))
        out.append(item)
    return out


HOSTS_CACHE = [0.0, []]   # [time, hostcomputers] — чтобы действия не ждали лишний запрос


def all_hosts(gz, max_age=60):
    if time.time() - HOSTS_CACHE[0] > max_age or not HOSTS_CACHE[1]:
        HOSTS_CACHE[1] = gz.get("/api/hostcomputers") or []
        HOSTS_CACHE[0] = time.time()
    return HOSTS_CACHE[1]


def host_by_id(gz, host_id):
    for attempt in (60, 0):  # сначала из кэша, если ПК там нет — свежий список
        for h in all_hosts(gz, attempt):
            if h.get("id") == host_id and not h.get("isDeleted"):
                return h
    raise GizmoError("ПК не найден", 404)


def in_background(op, action, hname, fn):
    """Отправить команду и сразу ответить телефону; ошибку — в журнал."""
    def run():
        try:
            fn()
        except Exception as e:
            audit(op, action + "_failed", hname, str(e)[:200])
    POOL.submit(run)


# ───────────────────────── процессы ─────────────────────────

SYSTEM_EXES = {
    "explorer.exe", "dwm.exe", "sihost.exe", "ctfmon.exe", "taskhostw.exe", "runtimebroker.exe",
    "searchhost.exe", "searchapp.exe", "startmenuexperiencehost.exe", "textinputhost.exe",
    "shellexperiencehost.exe", "shellhost.exe", "applicationframehost.exe", "conhost.exe",
    "svchost.exe", "csrss.exe", "winlogon.exe", "fontdrvhost.exe", "smartscreen.exe",
    "securityhealthsystray.exe", "msedgewebview2.exe", "lockapp.exe", "tabtip.exe",
    "crossdeviceresume.exe", "systemsettings.exe", "defendersessionhelper.exe",
    "nvdisplay.container.exe", "widgets.exe", "widgetservice.exe", "phoneexperiencehost.exe",
    "userinit.exe", "dllhost.exe", "backgroundtaskhost.exe", "wmiprvse.exe", "audiodg.exe",
}
# Папки, внутри которых «следующая папка» = отдельная программа. Порядок важен: сначала более точные.
APP_ROOTS = ("\\program files\\windowsapps\\", "\\program files (x86)\\common files\\",
             "\\program files\\common files\\", "\\program files (x86)\\", "\\program files\\",
             "\\appdata\\local\\programs\\", "\\appdata\\local\\", "\\appdata\\roaming\\")
USER_ROOT = re.compile(r"\\users\\[^\\]+\\(?:(?:desktop|downloads|documents|рабочий стол)\\)?", re.I)


def is_protected(exe):
    e = (exe or "").lower()
    return e in SYSTEM_EXES or "gizmo" in e


def exe_path(p):
    cl = (p.get("commandLine") or "").strip()
    if cl.startswith('"\\\\?\\'):
        cl = '"' + cl[5:]
    if cl.startswith('"'):
        return cl[1:].split('"', 1)[0]
    m = re.match(r"^(.+?\.exe)\b", cl, re.I)
    return m.group(1) if m else cl


def app_key(path, exe):
    """Группируем процессы одной программы по папке установки: …\\Steam\\…, …\\Discord\\…"""
    low = path.lower()
    for root in APP_ROOTS:
        i = low.find(root)
        if i >= 0:
            rest = path[i + len(root):]
            if "\\" in rest:
                return path[:i + len(root)] + rest.split("\\", 1)[0]
    m = USER_ROOT.search(path)
    if m:
        rest = path[m.end():]
        if "\\" in rest:
            return path[:m.end()] + rest.split("\\", 1)[0]
    folder = path.rsplit("\\", 1)[0] if "\\" in path else ""
    return folder or exe.lower()


def parse_span(s):
    """'00:01:58.1093750' или '1.02:03:04.5' → секунды."""
    if not s:
        return 0.0
    days = 0
    if "." in s.split(":")[0]:
        d, s = s.split(".", 1)
        days = int(d)
    try:
        h, m, sec = s.split(":")
        return days * 86400 + int(h) * 3600 + int(m) * 60 + float(sec)
    except ValueError:
        return 0.0


def user_processes(procs):
    out = []
    for p in procs or []:
        exe = p.get("processExeName") or ((p.get("processName") or "") + ".exe")
        if not p.get("sessionId") or p.get("hasExited"):
            continue
        path = exe_path(p)
        if not path or "\\windows\\" in path.lower() or is_protected(exe):
            continue
        out.append((p, exe, path))
    return out


GROUP_CACHE = {}       # hostId -> (time, {key: group}) — для мгновенного «Завершить»


PROC_SNAP = {}         # hostId -> (time, {pid: cpuSeconds}) — предыдущий снимок для ЦП%


def process_groups(gz, host_id):
    """ОДИН запрос к ПК. ЦП% считаем по разнице с предыдущим снимком этого же ПК
    (первый показ — без ЦП, следующий через пару секунд — уже с ЦП)."""
    now = time.time()
    procs = gz.get(f"/api/hostcomputers/{host_id}/process", timeout=20) or []
    prev = PROC_SNAP.get(host_id)
    cur = {p.get("id"): parse_span(p.get("totalProcessorTime")) for p in procs}
    PROC_SNAP[host_id] = (now, cur)
    has_cpu = bool(prev and 0.5 < now - prev[0] < 60)
    elapsed = (now - prev[0]) if has_cpu else 1.0
    cpu0 = prev[1] if has_cpu else {}
    ncpu = max([p.get("processorCount") or 1 for p in procs] + [1])

    groups = {}
    for p, exe, path in user_processes(procs):
        key = app_key(path, exe)
        g = groups.setdefault(key, {"key": key, "procs": [], "cpu": 0.0, "icon": None,
                                    "name": None, "start": None, "exes": set()})
        pid = p.get("id")
        if has_cpu and pid in cpu0:
            g["cpu"] += max(0.0, cur.get(pid, 0.0) - cpu0[pid]) / elapsed / ncpu * 100
        g["procs"].append(p)
        g["exes"].add(exe)
        mm = p.get("mainModule") or {}
        if not g["icon"] and mm.get("iconData"):
            g["icon"] = mm["iconData"]
        st = parse_dt(p.get("startTime"))
        if st and (not g["start"] or st < g["start"]):
            g["start"] = st

    result = []
    for g in groups.values():
        pids = {p.get("id") for p in g["procs"]}
        roots = [p for p in g["procs"] if p.get("parentId") not in pids] or g["procs"][:1]
        main = roots[0]
        mm = main.get("mainModule") or {}
        name = mm.get("description") or os.path.splitext(main.get("processExeName") or "")[0] or g["key"]
        result.append({
            "key": g["key"], "name": name, "count": len(g["procs"]),
            "cpu": round(min(100.0, g["cpu"]), 1) if has_cpu else None,
            "started": g["start"].isoformat(timespec="seconds") if g["start"] else None,
            "icon": g["icon"], "exes": sorted(g["exes"]),
            "rootPids": [p.get("id") for p in roots],
        })
    result.sort(key=lambda x: (-(x["cpu"] or 0), x["name"].lower()))
    GROUP_CACHE[host_id] = (time.time(), {g["key"]: g for g in result})
    return result


def find_group(gz, host_id, key):
    """Группа из недавнего списка (без новых запросов к ПК); если устарел — один быстрый снимок."""
    c = GROUP_CACHE.get(host_id)
    if c and time.time() - c[0] < 180 and key in c[1]:
        return c[1][key]
    return {g["key"]: g for g in process_groups(gz, host_id)}.get(key)


# ───────────────────────── действия ─────────────────────────

def start_on_host(gz, host_id, file_name, arguments):
    return gz.call("PUT", f"/api/hostcomputers/{host_id}/process",
                   {"FileName": file_name, "Arguments": arguments, "CreateNoWindow": "true"})


def wake_on_lan(mac):
    digits = re.sub(r"[^0-9A-Fa-f]", "", mac or "")
    if len(digits) != 12:
        raise GizmoError("У ПК нет корректного MAC-адреса", 400)
    packet = b"\xff" * 6 + bytes.fromhex(digits) * 16
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        for port in (9, 7):
            s.sendto(packet, (WOL_BROADCAST, port))


# Тихое уведомление: плашка сверху по центру, НЕ забирает фокус (игру не свернёт),
# клики проходят сквозь неё, без кнопок, исчезает сама. Ошибки пишет в %TEMP%\club-toast.log на ПК.
QUIET_TOAST_PS = r"""
$log = Join-Path $env:TEMP 'club-toast.log'
try {
"$(Get-Date -Format s) старт" | Out-File -Append -Encoding utf8 $log
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @"
using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;
public class QuietToast : Form {
[DllImport("gdi32.dll")] static extern IntPtr CreateRoundRectRgn(int a, int b, int c, int d, int e, int f);
[DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
public QuietToast() { FormBorderStyle = FormBorderStyle.None; ShowInTaskbar = false; StartPosition = FormStartPosition.Manual; }
protected override bool ShowWithoutActivation { get { return true; } }
protected override CreateParams CreateParams { get {
CreateParams cp = base.CreateParams;
cp.ExStyle |= 0x08000000 | 0x00000080 | 0x00000008 | 0x00000020 | 0x00080000;
return cp; } }
public void Round(int r) { Region = Region.FromHrgn(CreateRoundRectRgn(0, 0, Width + 1, Height + 1, r, r)); }
public void KeepOnTop() { SetWindowPos(Handle, new IntPtr(-1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010 | 0x0040); }
}
"@
[QuietToast]::SetProcessDPIAware() | Out-Null
$g = [System.Drawing.Graphics]::FromHwnd([IntPtr]::Zero); $k = $g.DpiX / 96.0; $g.Dispose()
$scr = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$w = [int][Math]::Min(560 * $k, $scr.Width - 40 * $k)
$pad = [int](18 * $k)
$f = New-Object QuietToast
$f.BackColor = [System.Drawing.Color]::FromArgb(23, 28, 34)
$f.Opacity = 0.0
$title = New-Object System.Windows.Forms.Label
$title.Text = 'Администратор'
$title.ForeColor = [System.Drawing.Color]::FromArgb(95, 211, 182)
$title.Font = New-Object System.Drawing.Font('Segoe UI Semibold', 9)
$title.AutoSize = $true
$title.Location = New-Object System.Drawing.Point(($pad + [int](12 * $k)), $pad)
$f.Controls.Add($title)
$msg = New-Object System.Windows.Forms.Label
$msg.ForeColor = [System.Drawing.Color]::FromArgb(238, 241, 244)
$msg.Font = New-Object System.Drawing.Font('Segoe UI', 13)
$msg.MaximumSize = New-Object System.Drawing.Size(($w - 2 * $pad - [int](12 * $k)), 0)
$msg.AutoSize = $true
$msg.Text = '__TEXT__'
$msg.Location = New-Object System.Drawing.Point(($pad + [int](12 * $k)), ($title.Bottom + [int](2 * $k)))
$f.Controls.Add($msg)
$h = $msg.Bottom + $pad
$bar = New-Object System.Windows.Forms.Panel
$bar.BackColor = [System.Drawing.Color]::FromArgb(95, 211, 182)
$bar.Location = New-Object System.Drawing.Point($pad, $pad)
$bar.Size = New-Object System.Drawing.Size([int](4 * $k), ($h - 2 * $pad))
$f.Controls.Add($bar)
$f.Size = New-Object System.Drawing.Size($w, $h)
$f.Location = New-Object System.Drawing.Point(($scr.X + [int](($scr.Width - $w) / 2)), ($scr.Y + [int](24 * $k)))
$f.Round([int](16 * $k))
$global:tt = 0
$global:hold = __SECONDS__ * 1000
$global:tf = $f
$tm = New-Object System.Windows.Forms.Timer
$tm.Interval = 30
$global:tmr = $tm
$tm.Add_Tick({
$global:tt += 30
$global:tf.KeepOnTop()
if ($global:tt -le 240) { $global:tf.Opacity = [Math]::Min(0.95, $global:tt / 240 * 0.95) }
elseif ($global:tt -ge ($global:hold + 240)) {
$global:tf.Opacity = [Math]::Max(0, $global:tf.Opacity - 0.08)
if ($global:tf.Opacity -le 0.02) { $global:tmr.Stop(); $global:tf.Close() }
}
})
$tm.Start()
"$(Get-Date -Format s) показ" | Out-File -Append -Encoding utf8 $log
[System.Windows.Forms.Application]::Run($f)
} catch {
"$(Get-Date -Format s) ОШИБКА: $($_.Exception.Message)" | Out-File -Append -Encoding utf8 $log
}
"""

# Окно с кнопкой ОК (поверх всего) — у вас уже работало; режим MESSAGE_MODE=box
BOX_PS = r"""
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.MessageBox]::Show('__TEXT__', 'Сообщение от администратора', 'OK', 'Information', 'Button1', 'ServiceNotification') | Out-Null
"""


def ps_args(template, text, seconds=7):
    script = (template.replace("__TEXT__", text.replace("'", "''"))
              .replace("__SECONDS__", str(int(seconds))))
    script = "\n".join(line.strip() for line in script.splitlines() if line.strip())
    # Сжимаем (deflate) и передаём в base64: запрос к Gizmo короткий, кавычки и кириллица не ломаются.
    import zlib
    raw = zlib.compress(script.encode("utf-8"), 9)[2:-4]          # «голый» deflate для DeflateStream
    b64 = base64.b64encode(raw).decode("ascii")
    boot = ("$d=New-Object IO.Compression.DeflateStream((New-Object IO.MemoryStream(,[Convert]::FromBase64String('" + b64 +
            "'))),([IO.Compression.CompressionMode]::Decompress));"
            "iex ((New-Object IO.StreamReader($d,[Text.Encoding]::UTF8)).ReadToEnd())")
    return f'-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -Command "{boot}"'


def quiet_toast_args(text, seconds=7):
    return ps_args(QUIET_TOAST_PS, text, seconds)


PS64 = r"C:\Windows\Sysnative\WindowsPowerShell\v1.0\powershell.exe"


def send_message(gz, host_id, text, seconds=7):
    """Сообщение на экран ПК — способ задаёт MESSAGE_MODE в .env:
    toast (по умолчанию) — тихая плашка сверху; box — окно с ОК; msg — msg.exe.
    Если нужный файл на ПК не найден — пробуем следующий способ."""
    toast = [("toast", PS64, quiet_toast_args(text, seconds)), ("toast", "powershell.exe", quiet_toast_args(text, seconds))]
    box = [("box", PS64, ps_args(BOX_PS, text)), ("box", "powershell.exe", ps_args(BOX_PS, text))]
    msg = [("msg", r"C:\Windows\Sysnative\msg.exe", f"* /TIME:120 {text}"),
           ("msg", r"C:\Windows\System32\msg.exe", f"* /TIME:120 {text}")]
    order = {"box": box + msg, "msg": msg + box}.get(MESSAGE_MODE, toast + box + msg)
    last = None
    for name, exe, args in order:
        try:
            start_on_host(gz, host_id, exe, args)
            return name
        except GizmoError as e:
            low = str(e).lower()
            if "найти" in low or "cannot find" in low or "not find" in low or "не удается" in low:
                last = e
                continue
            raise
    raise last or GizmoError("Не удалось показать сообщение", 502)


def clean_text(t, limit=200):
    t = re.sub(r'[\x00-\x1f"\\^&|<>%]', " ", str(t or "")).strip()
    return re.sub(r"\s+", " ", t)[:limit]


# ───────────────────────── смена и склад ─────────────────────────

def active_shift(gz):
    now = datetime.now()
    rep = gz.get("/api/reports/shiftslog", {
        "ShiftsLogReportType": 1,
        "DateFrom": (now - timedelta(days=3)).strftime("%Y-%m-%dT00:00:00"),
        "DateTo": now.strftime("%Y-%m-%dT23:59:59")})
    shifts = (rep or {}).get("shifts") or [] if isinstance(rep, dict) else []
    act = [s for s in shifts if s.get("isActive")]
    if not act:
        return {"active": False}
    s = max(act, key=lambda x: x.get("startTime") or "")
    return {"active": True, "register": s.get("registerName"), "operator": s.get("operatorName"),
            "start": (parse_dt(s.get("startTime")) or now).isoformat(timespec="seconds"),
            "expected": s.get("expected")}


def stock_list(gz):
    products = [p for p in (gz.get("/api/products") or []) if not p.get("isDeleted")]
    try:
        time_ids = {p.get("id") for p in (gz.get("/api/products/time") or [])}
    except GizmoError:
        time_ids = set()
    products = [p for p in products if p.get("id") not in time_ids]

    def level(pid):
        try:
            return gz.get(f"/api/stock/{pid}", timeout=8)
        except GizmoError:
            return None
    levels = dict(zip([p["id"] for p in products], POOL.map(level, [p["id"] for p in products])))
    return [{"id": p["id"], "name": p.get("name"), "price": p.get("price"),
             "barcode": p.get("barcode") or None, "stock": levels.get(p["id"])}
            for p in sorted(products, key=lambda x: (x.get("displayOrder") or 0, x.get("name") or ""))]


# ───────────────────────── HTTP ─────────────────────────

MIME = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml",
        ".json": "application/json", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json"}


class Handler(BaseHTTPRequestHandler):
    server_version = "ClubAdmin/0.1"

    def log_message(self, fmt, *args):
        pass

    # --- ответы ---
    def send_json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_static(self, rel):
        rel = rel.lstrip("/") or "index.html"
        path = os.path.normpath(os.path.join(APP_DIR, rel))
        if not path.startswith(APP_DIR) or not os.path.isfile(path):
            path = os.path.join(APP_DIR, "index.html")
            if not os.path.isfile(path):
                return self.send_json(404, {"error": "Нет папки app с index.html"})
        with open(path, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(os.path.splitext(path)[1].lower(), "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def body_json(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > 64 * 1024:
            raise GizmoError("Слишком большой запрос", 413)
        try:
            return json.loads(self.rfile.read(n) or b"{}")
        except json.JSONDecodeError:
            raise GizmoError("Неверный JSON", 400)

    def session(self):
        h = self.headers.get("Authorization") or ""
        tok = h[7:] if h.startswith("Bearer ") else ""
        s = get_session(tok) if tok else None
        if not s:
            raise GizmoError("Нужно войти заново", 401)
        return tok, s

    # --- маршруты ---
    def do_GET(self):
        self.route("GET")

    def do_POST(self):
        self.route("POST")

    def route(self, method):
        path = urllib.parse.urlparse(self.path).path
        try:
            if not path.startswith("/api/"):
                if method == "GET":
                    return self.send_static(path)
                return self.send_json(405, {"error": "Метод не поддерживается"})
            return self.api(method, path)
        except GizmoError as e:
            return self.send_json(e.status, {"error": str(e), "offline": e.offline})
        except Exception as e:
            print("  [ошибка]", repr(e))
            return self.send_json(500, {"error": "Внутренняя ошибка сервера"})

    def api(self, method, path):
        ip = self.client_address[0]
        # за `tailscale serve` все запросы приходят с 127.0.0.1 — настоящий адрес в заголовке
        if ip in ("127.0.0.1", "::1") and self.headers.get("X-Forwarded-For"):
            ip = self.headers["X-Forwarded-For"].split(",")[0].strip()

        if path == "/api/ping" and method == "GET":
            return self.send_json(200, {"ok": True, "club": CLUB_NAME, "time": datetime.now().isoformat(timespec="seconds")})

        if path == "/api/login" and method == "POST":
            if login_blocked(ip):
                raise GizmoError("Слишком много попыток. Подождите 5 минут.", 429)
            b = self.body_json()
            user, pw = str(b.get("login") or "").strip(), str(b.get("password") or "")
            if not user or not pw:
                raise GizmoError("Введите логин и пароль", 400)
            try:
                version = Gizmo(user, pw).get("/api/service/version", timeout=8)
            except GizmoError as e:
                if e.status == 401:
                    login_failed(ip)
                raise
            token = new_session(user, pw)
            audit(user, "login", detail=f"с {ip}")
            return self.send_json(200, {"token": token, "operator": user, "club": CLUB_NAME, "gizmo": version})

        tok, s = self.session()
        gz = Gizmo(s["user"], s["pass"])
        op = s["user"]

        if path == "/api/logout" and method == "POST":
            with LOCK:
                SESSIONS.pop(tok, None)
            audit(op, "logout")
            return self.send_json(200, {"ok": True})

        if path == "/api/me" and method == "GET":
            return self.send_json(200, {"operator": op, "club": CLUB_NAME})

        if path == "/api/hosts" and method == "GET":
            return self.send_json(200, {"hosts": list_hosts(gz)})

        if path == "/api/shift" and method == "GET":
            return self.send_json(200, active_shift(gz))

        if path == "/api/stock" and method == "GET":
            return self.send_json(200, {"products": stock_list(gz)})

        m = re.fullmatch(r"/api/hosts/(\d+)/(processes|kill|reboot|shutdown|wake|message|techtime)", path)
        if not m:
            return self.send_json(404, {"error": "Нет такого метода"})
        host_id, action = int(m.group(1)), m.group(2)

        if action == "processes" and method == "GET":
            return self.send_json(200, {"apps": process_groups(gz, host_id)})

        if method != "POST":
            return self.send_json(405, {"error": "Нужен POST"})
        b = self.body_json()
        host = host_by_id(gz, host_id)
        hname = host.get("name") or host.get("hostname") or str(host_id)

        if action == "kill":
            key = str(b.get("key") or "")
            g = find_group(gz, host_id, key)
            if not g:
                raise GizmoError("Программа уже закрыта или не найдена", 404)
            if any(is_protected(e) for e in g["exes"]):
                raise GizmoError("Эту программу завершать нельзя", 403)

            def kill(pid):
                try:
                    gz.call("DELETE", f"/api/hostcomputers/{host_id}/process", {"ProcessId": pid, "Tree": "true"}, timeout=10)
                    return None
                except GizmoError as e:
                    return e
            errors = [e for e in POOL.map(kill, g["rootPids"]) if e]   # все корни — параллельно
            if errors and len(errors) == len(g["rootPids"]):
                raise errors[0]
            c = GROUP_CACHE.get(host_id)
            if c:
                c[1].pop(key, None)
            audit(op, "kill", hname, g["name"])
            return self.send_json(200, {"ok": True, "name": g["name"]})

        if action in ("reboot", "shutdown"):
            # /t 0 — сразу, без окна-предупреждения; /f — не ждать, пока закроются программы.
            # Команду отправляем в фоне: телефон получает ответ мгновенно.
            args = "/r /f /t 0" if action == "reboot" else "/s /f /t 0"
            in_background(op, action, hname, lambda: start_on_host(gz, host_id, "shutdown.exe", args))
            STATUS_CACHE.pop(host_id, None)
            audit(op, action, hname)
            return self.send_json(200, {"ok": True})

        if action == "wake":
            wake_on_lan(host.get("macAddress"))
            WAKE_REQUESTS[host_id] = time.time()
            STATUS_CACHE.pop(host_id, None)
            audit(op, "wake", hname, host.get("macAddress") or "")
            return self.send_json(200, {"ok": True})

        if action == "message":
            text = clean_text(b.get("text"))
            if not text:
                raise GizmoError("Пустое сообщение", 400)
            try:
                seconds = min(30, max(3, int(b.get("seconds") or 7)))
            except (TypeError, ValueError):
                seconds = 7

            def deliver():
                used = send_message(gz, host_id, text, seconds)
                audit(op, "message", hname, f"{text} [{used}]")
            in_background(op, "message", hname, deliver)
            return self.send_json(200, {"ok": True})

        if action == "techtime":
            try:
                minutes = int(b.get("minutes") or 0)
            except (TypeError, ValueError):
                minutes = 0
            if not 1 <= minutes <= 240:
                raise GizmoError("Укажите от 1 до 240 минут", 400)
            reason = clean_text(b.get("reason"), 120) or "без причины"
            sess = [s_ for s_ in (gz.get("/api/usersessions/active") or []) if s_.get("hostId") == host_id]
            if not sess:
                raise GizmoError("На этом ПК сейчас никто не сидит", 409)
            uid = sess[0].get("userId")
            amount = minutes * 60 if TECH_TIME_UNIT.startswith("sec") else minutes
            # цена 0 — бесплатное (техническое) время; в Gizmo остаётся счёт на 0 ₽ для отчётов
            gz.call("POST", f"/api/users/{uid}/order/time/{amount}/price/0/invoice")
            name = user_name(gz, uid)
            audit(op, "techtime", hname, f"{name}: {minutes} мин ({reason})")
            return self.send_json(200, {"ok": True, "user": name, "minutes": minutes, "reason": reason, "host": hname})

        return self.send_json(404, {"error": "Нет такого метода"})


def local_addresses():
    addrs = set()
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            addrs.add(info[4][0])
    except socket.gaierror:
        pass
    # адрес Tailscale Windows через getaddrinfo часто не отдаёт — спросим сам Tailscale
    import subprocess
    for exe in ("tailscale", r"C:\Program Files\Tailscale\tailscale.exe"):
        try:
            out = subprocess.run([exe, "ip", "-4"], capture_output=True, text=True, timeout=4,
                                 creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)).stdout
            addrs.update(x.strip() for x in out.split() if x.strip())
            break
        except (OSError, subprocess.SubprocessError):
            continue
    good = []
    for a in sorted(addrs):
        try:
            ip = ipaddress.ip_address(a)
        except ValueError:
            continue
        if ip.is_loopback or ip.is_link_local:
            continue
        tag = " (Tailscale)" if ip in ipaddress.ip_network("100.64.0.0/10") else ""
        good.append(a + tag)
    return good


def main():
    print("Админка клуба — бэкенд")
    print(f"  Gizmo API:   {GIZMO_URL}")
    try:
        urllib.request.build_opener(urllib.request.ProxyHandler({})).open(GIZMO_URL + "/api/service/version", timeout=5)
    except urllib.error.HTTPError:
        print("  ✓ Gizmo отвечает")
    except Exception as e:
        print(f"  ! Gizmo пока не отвечает ({e}). Сервер всё равно запущу.")
    srv = ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), Handler)
    srv.daemon_threads = True
    print(f"  Приложение:  http://localhost:{LISTEN_PORT}")
    for a in local_addresses():
        print(f"               http://{a.split(' ')[0]}:{LISTEN_PORT}{a[len(a.split(' ')[0]):]}")
    print("  Остановить: Ctrl+C\n")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nОстановлен.")


if __name__ == "__main__":
    main()
