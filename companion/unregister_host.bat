@echo off
setlocal

chcp 65001 >nul 2>&1

set "HOST_NAME=com.multipip.host"

reg delete "HKCU\Software\Google\Chrome\NativeMessagingHosts\%HOST_NAME%" /f >nul 2>&1
reg delete "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\%HOST_NAME%" /f >nul 2>&1
reg delete "HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\%HOST_NAME%" /f >nul 2>&1
reg delete "HKCU\Software\Chromium\NativeMessagingHosts\%HOST_NAME%" /f >nul 2>&1

echo ========================================================
echo  [完成] Multi-PiP 原生伴侣程序已从系统注册表中彻底移除。
echo ========================================================
echo.
pause
