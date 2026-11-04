@echo off
setlocal

set "PATH=%SystemRoot%\System32;%SystemRoot%;%PATH%"
set "REG=%SystemRoot%\System32\reg.exe"
if not exist "!REG!" set "REG=reg.exe"

set "HOST=com.multipip.host"

"%REG%" delete "HKCU\Software\Google\Chrome\NativeMessagingHosts\%HOST%" /f >nul 2>&1
"%REG%" delete "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\%HOST%" /f >nul 2>&1
"%REG%" delete "HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\%HOST%" /f >nul 2>&1
"%REG%" delete "HKCU\Software\Chromium\NativeMessagingHosts\%HOST%" /f >nul 2>&1

echo ========================================================
echo  [OK] Multi-PiP companion removed from system registry.
echo ========================================================
echo.
pause
