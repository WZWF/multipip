@echo off
setlocal

set "PATH=%SystemRoot%\System32;%SystemRoot%;%SystemRoot%\System32\Wbem;!PATH!"

set "REG_EXE=%SystemRoot%\System32\reg.exe"
if not exist "%REG_EXE%" set "REG_EXE=reg.exe"

set "CHCP_EXE=%SystemRoot%\System32\chcp.com"
if exist "%CHCP_EXE%" ("%CHCP_EXE%" 936 >nul 2>&1)

set "HOST_NAME=com.multipip.host"

"%REG_EXE%" delete "HKCU\Software\Google\Chrome\NativeMessagingHosts\%HOST_NAME%" /f >nul 2>&1
"%REG_EXE%" delete "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\%HOST_NAME%" /f >nul 2>&1
"%REG_EXE%" delete "HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\%HOST_NAME%" /f >nul 2>&1
"%REG_EXE%" delete "HKCU\Software\Chromium\NativeMessagingHosts\%HOST_NAME%" /f >nul 2>&1

echo ========================================================
echo  [完成] Multi-PiP 原生伴侣程序已从系统注册表中彻底移除。
echo ========================================================
echo.
pause
