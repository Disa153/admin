@echo off
chcp 65001 >nul
echo Показываю плашку на 6 секунд...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0test_toast.ps1"
echo.
echo Журнал плашки (%TEMP%\club-toast.log):
type "%TEMP%\club-toast.log"
pause
