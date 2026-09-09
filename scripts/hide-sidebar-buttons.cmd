@echo off
rem Hide the bottom-left "Memory" / "Lark" / "Automation" sidebar buttons
rem and the top "Wallpaper Repository" button.
rem Idempotent and safe to re-run after every plugin update.
chcp 65001 >nul
where pwsh >nul 2>nul
if %errorlevel%==0 (
    pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0hide-sidebar-buttons.ps1" %*
) else (
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0hide-sidebar-buttons.ps1" %*
)
echo.
pause