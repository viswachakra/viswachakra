@echo off
REM Watchdog for the full resync. Triggered every 10 min by Task Scheduler.
REM Relaunches node resync-all.js (which resumes from its done-file) ONLY when no resync
REM is already running, so it never creates a second concurrent portal session — regardless
REM of whether the running instance was started here or manually. When the done-file is
REM complete, resync-all exits immediately, so ticks become harmless no-ops.
cd /d "C:\Users\bhanu\Downloads\viswachakra"

REM bail out if a resync-all node is already alive
powershell -NoProfile -Command "if (Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*resync-all.js*' }) { exit 1 }"
if errorlevel 1 exit /b

set HEADLESS=true
echo ===== resync tick %date% %time% ===== >> "logs\resync-all.out"
node resync-all.js >> "logs\resync-all.out" 2>> "logs\resync-all.err"
