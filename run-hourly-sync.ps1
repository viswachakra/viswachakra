# Hourly incremental sync WITH A DEADLINE.
#
# Why this exists: a stalled run used to sit until the next hourly task killed
# it, costing a full hour of syncing and losing its buffered log output. Across
# the log history 49 of 277 runs (18%) never finished this way. Each step now
# gets a hard deadline; if it is exceeded the process tree is killed, the fact
# is written to the log, and the run moves on so the next hour starts clean.
#
# Called by run-hourly-sync.bat, which is what Task Scheduler launches.
# Safe to run by hand:  powershell -ExecutionPolicy Bypass -File run-hourly-sync.ps1
param(
  [int]$ScraperMinutes = 40,   # leaves headroom before the next hourly task
  [int]$PushMinutes    = 10
)

$ErrorActionPreference = 'Continue'
Set-Location $PSScriptRoot
if (-not (Test-Path 'logs')) { New-Item -ItemType Directory -Path 'logs' | Out-Null }
$Log = Join-Path $PSScriptRoot 'logs\hourly-sync.log'

# The child cmd.exe holds the log open via ">>", so a write can briefly collide
# with it. Retry rather than silently losing the line - the watchdog message is
# the whole point of this script.
function Write-Log($msg) {
  for ($i = 0; $i -lt 10; $i++) {
    try { Add-Content -Path $Log -Encoding utf8 -Value $msg -ErrorAction Stop; return }
    catch { Start-Sleep -Milliseconds 400 }
  }
}

# Run one command with a deadline. Output is appended to the log by cmd itself,
# so redirection semantics match the old batch file. Returns $true if it
# finished within the deadline.
function Invoke-WithDeadline($commandLine, $minutes, $label) {
  $p = Start-Process -FilePath 'cmd.exe' `
                     -ArgumentList '/c', "$commandLine >> `"$Log`" 2>&1" `
                     -PassThru -WindowStyle Hidden
  if ($p.WaitForExit($minutes * 60 * 1000)) {
    return $true
  }
  # Deadline blown: kill the whole tree (cmd -> node -> chrome), not just cmd.
  # Kill BEFORE logging - the child still holds the log file open via ">>", so
  # appending first would throw and lose the message.
  & taskkill.exe /PID $p.Id /T /F 2>&1 | Out-Null
  Start-Sleep -Seconds 3
  Write-Log "===== WATCHDOG: $label exceeded $minutes min - killed PID $($p.Id) ====="
  return $false
}

Write-Log "===== sync started $(Get-Date -Format 'dd-MM-yyyy HH:mm:ss') ====="

$env:HEADLESS = 'true'

# Scrape only what changed recently, then push ONLY those cases. Deliberately no
# global summary recompute here - see the note in run-hourly-sync.bat.
$scraped = Invoke-WithDeadline 'node scraper.js --hours 2 --headless' $ScraperMinutes 'scraper'

if ($scraped) {
  Invoke-WithDeadline 'node push-to-supabase.js --since-minutes 130' $PushMinutes 'push' | Out-Null
} else {
  # The scraper was killed mid-flight, so its SQLite writes are partial and the
  # --since-minutes window would push an inconsistent slice. Skip and let the
  # next hour re-scrape the same window cleanly.
  Write-Log '===== WATCHDOG: scraper did not finish - skipping push this run ====='
}

Write-Log "===== sync finished $(Get-Date -Format 'dd-MM-yyyy HH:mm:ss') ====="
