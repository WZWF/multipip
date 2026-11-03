@echo off
setlocal enabledelayedexpansion

:: 1. 自动补全系统路径，防止精简系统或环境变量丢失导致找不到 reg / chcp
set "PATH=%SystemRoot%\System32;%SystemRoot%;%SystemRoot%\System32\Wbem;!PATH!"

:: 2. 准确定位系统核心组件
set "REG_EXE=%SystemRoot%\System32\reg.exe"
if not exist "!REG_EXE!" set "REG_EXE=reg.exe"

set "CHCP_EXE=%SystemRoot%\System32\chcp.com"
if exist "!CHCP_EXE!" (!CHCP_EXE! 936 >nul 2>&1)

echo ========================================================
echo       Multi-PiP 无边框伴侣程序自动注册工具 (Win10/11)
echo ========================================================
echo.

:: 3. 定位当前目录及核心程序
set "CURRENT_DIR=%~dp0"
set "EXE_PATH=%CURRENT_DIR%dist\multipip_host\multipip_host.exe"
set "JSON_PATH=%CURRENT_DIR%com.multipip.host.json"

if not exist "%EXE_PATH%" (
    echo [错误] 找不到伴侣核心程序:
    echo %EXE_PATH%
    echo 请确认未将脚本移出 companion 目录，且文件已完整解压。
    echo.
    pause
    exit /b 1
)

:: 4. 转换为跨平台与 JSON 100% 兼容的标准正斜杠绝对路径
set "SLASH_EXE=!EXE_PATH:\=/!"

echo [1/3] 正在配置本地宿主清单 (com.multipip.host.json)...
(
    echo {
    echo   "name": "com.multipip.host",
    echo   "description": "Multi-PiP frameless always-on-top video window host",
    echo   "path": "!SLASH_EXE!",
    echo   "type": "stdio",
    echo   "allowed_origins": [
    echo     "chrome-extension://eeipfkplhoehahlfkehbahcnpkebhkob/"
    echo   ]
    echo }
) > "%JSON_PATH%"

if not exist "%JSON_PATH%" (
    echo [错误] 生成清单文件失败，请检查文件夹是否有写入权限！
    echo.
    pause
    exit /b 1
)
echo [成功] 清单文件已就绪: %JSON_PATH%
echo.

:: 5. 写入当前用户注册表 (HKCU 无需管理员权限)
echo [2/3] 正在写入当前用户注册表 HKCU...

"!REG_EXE!" add "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.multipip.host" /ve /t REG_SZ /d "%JSON_PATH%" /f >nul 2>&1
if !errorlevel! equ 0 (echo  - Google Chrome: 注册成功) else (echo  - Google Chrome: 写入异常)

"!REG_EXE!" add "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.multipip.host" /ve /t REG_SZ /d "%JSON_PATH%" /f >nul 2>&1
if !errorlevel! equ 0 (echo  - Microsoft Edge: 注册成功) else (echo  - Microsoft Edge: 写入异常)

"!REG_EXE!" add "HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.multipip.host" /ve /t REG_SZ /d "%JSON_PATH%" /f >nul 2>&1
if !errorlevel! equ 0 (echo  - Brave Browser: 注册成功)

"!REG_EXE!" add "HKCU\Software\Chromium\NativeMessagingHosts\com.multipip.host" /ve /t REG_SZ /d "%JSON_PATH%" /f >nul 2>&1
if !errorlevel! equ 0 (echo  - Chromium: 注册成功)

echo.
echo [3/3] 正在校验注册结果...
"!REG_EXE!" query "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.multipip.host" /ve >nul 2>&1
set "CHROME_OK=!errorlevel!"
"!REG_EXE!" query "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.multipip.host" /ve >nul 2>&1
set "EDGE_OK=!errorlevel!"

if "!CHROME_OK!"=="0" (
    set "REG_SUCCESS=1"
) else if "!EDGE_OK!"=="0" (
    set "REG_SUCCESS=1"
) else (
    set "REG_SUCCESS=0"
)

echo.
if "!REG_SUCCESS!"=="1" (
    echo ========================================================
    echo  [安装成功] Multi-PiP 无边框伴侣程序已顺利注册完成！
    echo ========================================================
    echo 提示: 回到浏览器打开 chrome://extensions/ 刷新一下扩展即可生效。
) else (
    echo [警告] 注册表未能成功校验，可能受到安全防护软件拦截，请允许写入后重试。
)
echo.
pause
