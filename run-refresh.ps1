# Watchdog + auto-restart runner for the long refresh scrapes.
# Runs the given node script; if its done-file stops advancing for >StaleMin minutes
# (a hang), kills it and resumes. Exits when the script completes cleanly (exit 0).
# Usage: powershell -File run-refresh.ps1 -Script refresh-unpaid.js -DoneFile logs\refresh-unpaid-done.txt
param(
  [string]$Script = "refresh-unpaid.js",
  [string]$DoneFile = "logs\refresh-unpaid-done.txt",
  [int]$StaleMin = 6,
  [int]$MaxAttempts = 80
)
$root = $PSScriptRoot
Set-Location $root
if (-not (Test-Path (Join-Path $root 'logs'))) { New-Item -ItemType Directory -Path (Join-Path $root 'logs') | Out-Null }
$df = Join-Path $root $DoneFile

for ($a = 1; $a -le $MaxAttempts; $a++) {
  Write-Output "=== attempt $a $(Get-Date -Format 'HH:mm:ss') ==="
  # clear any orphaned headless chrome from a prior crash/kill
  Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -eq '' } | Stop-Process -Force -ErrorAction SilentlyContinue
  # reset watchdog baseline so a stale mtime from a prior run can't trigger an instant kill
  if (Test-Path $df) { (Get-Item $df).LastWriteTime = Get-Date }

  $p = Start-Process -FilePath "node" -ArgumentList $Script -PassThru -NoNewWindow
  $killed = $false
  while (-not $p.HasExited) {
    Start-Sleep -Seconds 60
    if (Test-Path $df) {
      $age = ((Get-Date) - (Get-Item $df).LastWriteTime).TotalMinutes
      if ($age -gt $StaleMin) {
        Write-Output "watchdog: done-file stale $([int]$age) min -> killing node PID $($p.Id)"
        Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
        $killed = $true
        break
      }
    }
  }
  if (-not $p.HasExited) { $p.WaitForExit() }
  if ((-not $killed) -and ($p.ExitCode -eq 0)) { Write-Output "DONE cleanly at $(Get-Date -Format 'HH:mm:ss')"; break }
  Write-Output "run ended (killed=$killed exitcode=$($p.ExitCode)); resuming in 8s"
  Start-Sleep -Seconds 8
}
Write-Output "runner finished at $(Get-Date -Format 'HH:mm:ss')"
