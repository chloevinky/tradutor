@echo off
rem Tradutor — visible launcher (shows server logs; use start.vbs for silent).
cd /d "%~dp0"
start "" /min cmd /c "timeout /t 1 >nul && start "" http://localhost:4747"
node server.js
pause
