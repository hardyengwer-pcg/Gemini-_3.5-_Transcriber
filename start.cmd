@echo off
cd /d "%~dp0"
echo ========================================================
echo   Starting Google Transcriber Desktop App...
echo ========================================================
npm start
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo Anwendungsstart fehlgeschlagen (Exit-Code: %ERRORLEVEL%).
    pause
)
