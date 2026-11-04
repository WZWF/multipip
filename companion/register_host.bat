@echo off
setlocal enabledelayedexpansion

REM Ensure system directory is in PATH in case user environment is broken
set "PATH=%SystemRoot%\System32;%SystemRoot%;%PATH%"

REM Locate reg.exe with absolute system path
set "REG=%SystemRoot%\System32\reg.exe"
if not exist "!REG!" set "REG=reg.exe"

echo ========================================================
echo   Multi-PiP Companion Host Register Script (Win10/11)
echo ========================================================
echo.

REM Resolve absolute paths for the executable and json file
set "DIR=%~dp0"
set "EXE=%DIR%dist\multipip_host\multipip_host.exe"
set "JSON=%DIR%com.multipip.host.json"

if not exist "%EXE%" (
    echo [ERROR] Cannot find host executable at:
    echo %EXE%
    echo Please extract the zip package completely before running.
    echo.
    pause
    exit /b 1
)

REM Convert backslashes to forward slashes for universal JSON format
set "SLASH_EXE=!EXE:\=/!"

echo [1/3] Generating host manifest json...
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
) > "%JSON%"

if not exist "%JSON%" (
    echo [ERROR] Failed to write json file: %JSON%
    echo.
    pause
    exit /b 1
)
echo [OK] Json ready: %JSON%
echo.

echo [2/3] Writing to HKCU registry...

"!REG!" add "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.multipip.host" /ve /t REG_SZ /d "%JSON%" /f >nul 2>&1
if !errorlevel! equ 0 (echo  - Google Chrome: OK) else (echo  - Google Chrome: FAILED)

"!REG!" add "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.multipip.host" /ve /t REG_SZ /d "%JSON%" /f >nul 2>&1
if !errorlevel! equ 0 (echo  - Microsoft Edge: OK) else (echo  - Microsoft Edge: FAILED)

"!REG!" add "HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.multipip.host" /ve /t REG_SZ /d "%JSON%" /f >nul 2>&1
if !errorlevel! equ 0 (echo  - Brave Browser: OK)

"!REG!" add "HKCU\Software\Chromium\NativeMessagingHosts\com.multipip.host" /ve /t REG_SZ /d "%JSON%" /f >nul 2>&1
if !errorlevel! equ 0 (echo  - Chromium: OK)

echo.
echo [3/3] Verifying registry installation...
"!REG!" query "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.multipip.host" /ve >nul 2>&1
set "C_OK=!errorlevel!"
"!REG!" query "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.multipip.host" /ve >nul 2>&1
set "E_OK=!errorlevel!"

if "!C_OK!"=="0" (set "SUCCESS=1") else if "!E_OK!"=="0" (set "SUCCESS=1") else (set "SUCCESS=0")

echo.
if "!SUCCESS!"=="1" (
    echo ========================================================
    echo  [SUCCESS] Multi-PiP companion registered successfully!
    echo ========================================================
    echo Notice: Please refresh the extension at chrome://extensions/ now.
) else (
    echo [WARNING] Registry verification failed. Antivirus might have blocked HKCU.
)
echo.
pause
