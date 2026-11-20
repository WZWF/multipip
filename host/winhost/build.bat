@echo off
REM Build the Win32 topmost host (solo mode) into the extension package folder.
REM Requires Go 1.20+ on PATH (https://go.dev/dl/).
setlocal
cd /d "%~dp0"

where go >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Go toolchain not found on PATH.
    echo         Install from https://go.dev/dl/ and re-run this script.
    pause
    exit /b 1
)

set "OUT=%~dp0..\..\companion\dist\multipip_winhost"
if not exist "%OUT%" mkdir "%OUT%"

echo [1/2] Building multipip_winhost.exe ...
go build -trimpath -ldflags="-s -w" -o "%OUT%\multipip_winhost.exe" main.go
if errorlevel 1 (
    echo [ERROR] go build failed.
    pause
    exit /b 1
)

echo [2/2] Done: %OUT%\multipip_winhost.exe
for %%F in ("%OUT%\multipip_winhost.exe") do echo       size: %%~zF bytes
echo.
echo Next: double-click companion\register_host.bat, then reload the extension.
pause
