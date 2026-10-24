@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Админка клуба
if not exist ".env" copy ".env.example" ".env" >nul

set "PY="
if exist "%LOCALAPPDATA%\Programs\Python\Python312\python.exe" set "PY=%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
if not defined PY if exist "%LOCALAPPDATA%\Programs\Python\Python313\python.exe" set "PY=%LOCALAPPDATA%\Programs\Python\Python313\python.exe"
if not defined PY where py >nul 2>nul && set "PY=py"
if not defined PY (
  echo Python не найден. Установите: winget install Python.Python.3.12
  pause
  exit /b 1
)

"%PY%" server.py
pause
