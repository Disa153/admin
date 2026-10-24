
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @"
using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;
public class QuietToast : Form {
    [DllImport("gdi32.dll")] static extern IntPtr CreateRoundRectRgn(int a, int b, int c, int d, int e, int f);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    public QuietToast() {
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
    }
    protected override bool ShowWithoutActivation { get { return true; } }
    protected override CreateParams CreateParams {
        get {
            CreateParams cp = base.CreateParams;
            // NOACTIVATE | TOOLWINDOW | TOPMOST | TRANSPARENT (клики насквозь) | LAYERED
            cp.ExStyle |= 0x08000000 | 0x00000080 | 0x00000008 | 0x00000020 | 0x00080000;
            return cp;
        }
    }
    public void Round(int r) { Region = Region.FromHrgn(CreateRoundRectRgn(0, 0, Width + 1, Height + 1, r, r)); }
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
$msg.Text = 'Проверка уведомления: через 10 минут закрываемся'
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

$script:t = 0
$hold = 6 * 1000
$tm = New-Object System.Windows.Forms.Timer
$tm.Interval = 30
$tm.Add_Tick({
    $script:t += 30
    if ($script:t -le 240) { $f.Opacity = [Math]::Min(0.95, $script:t / 240 * 0.95) }
    elseif ($script:t -ge ($hold + 240)) {
        $f.Opacity = [Math]::Max(0, $f.Opacity - 0.08)
        if ($f.Opacity -le 0.02) { $tm.Stop(); $f.Close() }
    }
})
$tm.Start()
[System.Windows.Forms.Application]::Run($f)
