@echo off
title FbSuitesV2 Installer

:: Elevate ke admin
NET FILE 1>NUL 2>NUL
if errorlevel 1 (
    echo Requesting administrator privileges...
    powershell -Command "Start-Process '%~f0' -Verb runAs"
    exit /b
)

cd /d "%~dp0"

echo.
echo ============================================
echo   FbSuitesV2 Installer
echo ============================================
echo.
echo Downloading installer components...

set "PS1=%TEMP%\FbSuitesV2_install.ps1"

powershell -NoProfile -Command "try { Invoke-WebRequest 'https://raw.githubusercontent.com/rekapanptk-lang/FbSuitesV2/main/install.ps1' -OutFile '%PS1%' -UseBasicParsing; exit 0 } catch { Write-Host ('FAILED: ' + $_.Exception.Message) -ForegroundColor Red; exit 1 }"

if not exist "%PS1%" (
    echo.
    echo ERROR: Failed to download installer.
    echo Check internet connection and try again.
    echo.
    pause
    exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%"

del "%PS1%" 2>nul

echo.
pause
