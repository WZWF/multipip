@echo off
chcp 65001 >nul
setlocal

set "CURRENT_DIR=%~dp0"
set "EXE_PATH=%CURRENT_DIR%dist\multipip_host\multipip_host.exe"
set "JSON_PATH=%CURRENT_DIR%com.multipip.host.json"

if not exist "%EXE_PATH%" (
    echo [错误] 找不到伴侣程序可执行文件：%EXE_PATH%
    pause
    exit /b 1
)

reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.multipip.host" /ve /t REG_SZ /d "%JSON_PATH%" /f >nul
reg add "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.multipip.host" /ve /t REG_SZ /d "%JSON_PATH%" /f >nul
reg add "HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.multipip.host" /ve /t REG_SZ /d "%JSON_PATH%" /f >nul
reg add "HKCU\Software\Chromium\NativeMessagingHosts\com.multipip.host" /ve /t REG_SZ /d "%JSON_PATH%" /f >nul

echo [成功] Multi-PiP 无边框伴侣程序已完成注册（无需任何配置修改）！
pause
