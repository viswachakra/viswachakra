@echo off
REM Daily self-check: compares the app's alert lists with the portal's own and
REM repairs any difference. See self-check.js. Registered with Task Scheduler as
REM "ViswachakraDailySelfCheck" (06:20 every day), launched through
REM conhost --headless so no window appears on the desktop.
cd /d "%~dp0"
node self-check.js --headless >> logs\self-check-task.log 2>&1
