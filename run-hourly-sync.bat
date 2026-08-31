@echo off
REM Hourly incremental sync for the Viswachakra scraper — SAFE VERSION.
REM
REM Scrapes only cases changed in the last ~2h into local SQLite, then pushes ONLY those
REM freshly-scraped cases to Supabase (--since-minutes). It deliberately does NOT run a
REM global summary recompute:
REM   * a FULL push-to-supabase.js would re-derive claimed_amount/paid_amount/is_paid for
REM     every case from the (stale, incomplete) local SQLite workflow, and
REM   * update-summary-columns.js would recompute them for all 3318 cases from workflow,
REM     mislabelling the 34 legacy "-"-action paid claims as unpaid.
REM Either would wipe the settlement backfill. Keep this confined to fresh scrapes only.
REM
REM Registered with Windows Task Scheduler as "ViswachakraHourlySync" to run every hour.

REM Run from this script's own folder, so the same file works on any machine.
cd /d "%~dp0"
if not exist "logs" mkdir "logs"
set HEADLESS=true
echo ===== sync started %date% %time% ===== >> "logs\hourly-sync.log"
node scraper.js --hours 2 --headless >> "logs\hourly-sync.log" 2>&1
node push-to-supabase.js --since-minutes 130 >> "logs\hourly-sync.log" 2>&1
echo ===== sync finished %date% %time% ===== >> "logs\hourly-sync.log"
