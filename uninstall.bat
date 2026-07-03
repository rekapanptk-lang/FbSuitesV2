@echo off
title FbSuitesV2 Uninstaller

NET FILE 1>NUL 2>NUL
if errorlevel 1 (
    powershell -Command "Start-Process '%~f0' -Verb runAs"
    exit /b
)

echo.
echo ============================================
echo   FbSuitesV2 Uninstaller
echo ============================================
echo.
echo Ini akan hapus:
echo   - C:\Program Files\FbSuitesV2 (aplikasi)
echo   - Desktop shortcut
echo   - Registry entry (Add/Remove Programs)
echo.
echo Data user (cookies, profiles) di %%APPDATA%%\FbSuitesV2
echo TIDAK akan dihapus. Hapus manual kalau perlu.
echo.
set /p CONFIRM=Lanjut uninstall? (Y/N):

if /i not "%CONFIRM%"=="Y" (
    echo Cancelled.
    pause
    exit /b
)

echo.
echo Removing files...

:: Delete shortcut
del "%USERPROFILE%\Desktop\FB Suites V2.lnk" 2>nul

:: Delete registry
reg delete "HKLM\Software\Microsoft\Windows\CurrentVersion\Uninstall\FbSuitesV2" /f 2>nul

:: Delete install dir (self-delete trick — schedule via cmd after exit)
set "INSTALL_DIR=%ProgramFiles%\FbSuitesV2"

echo.
echo ============================================
echo   UNINSTALL COMPLETE
echo ============================================
echo.
echo Untuk hapus data karyawan (cookies, profiles):
echo   rmdir /s /q "%%APPDATA%%\FbSuitesV2"
echo.

:: Self-delete install dir setelah script exit
start "" cmd /c "timeout /t 2 /nobreak >nul && rmdir /s /q ""%INSTALL_DIR%"""

pause
exit /b
