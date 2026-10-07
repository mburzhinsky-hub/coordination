@echo off
chcp 65001 >nul
setlocal EnableExtensions EnableDelayedExpansion

set "BASE=%LOCALAPPDATA%\ITO-Coordination"
set "REPO=%BASE%\coordination"
set "ZIP=%TEMP%\coordination-main.zip"
set "TMP=%TEMP%\coordination-main"

echo.
echo ITO COORDINATION - INSTALL AND START
echo ====================================
echo.

where powershell.exe >nul 2>&1
if errorlevel 1 (
  echo PowerShell not found.
  pause
  exit /b 1
)

if not exist "%BASE%" mkdir "%BASE%"

if not exist "%REPO%\server\start-dashboard.ps1" (
  echo Downloading dashboard from GitHub...
  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
    "$ErrorActionPreference='Stop'; Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/mburzhinsky-hub/coordination/archive/refs/heads/main.zip' -OutFile '%ZIP%'; if(Test-Path '%TMP%'){Remove-Item '%TMP%' -Recurse -Force}; Expand-Archive -Path '%ZIP%' -DestinationPath '%TEMP%' -Force; if(Test-Path '%REPO%'){Remove-Item '%REPO%' -Recurse -Force}; Move-Item '%TEMP%\coordination-main' '%REPO%'; Remove-Item '%ZIP%' -Force"
  if errorlevel 1 (
    echo Failed to download the dashboard.
    pause
    exit /b 1
  )
)

echo Starting shared dashboard...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%REPO%\server\start-dashboard.ps1"

endlocal
