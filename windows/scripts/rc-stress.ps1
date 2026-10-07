# Runs the debug build under the AppHandle clone stress (src-tauri/src/rc_guard.rs)
# and reports whether it survived. Proves the vendored tauri-runtime-wry patch
# (patches/tauri-runtime-wry/PATCH.md): unpatched, the run aborts.
#
#   powershell -File scripts/rc-stress.ps1 [-Clones 200000] [-Seconds 60]
#
# Build first with `cargo build` in windows/. Exit code 0 = survived, 1 = crashed.
param(
  [int]$Clones = 200000,
  [int]$Seconds = 60
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $root "target\debug\coucou.exe"
if (-not (Test-Path $exe)) { throw "No debug build at $exe; run cargo build first." }
$ident = (Get-Content (Join-Path $root "src-tauri\tauri.conf.json") -Raw | ConvertFrom-Json).identifier

function Stop-Coucou {
  # An aborted run leaves its WebView2 children holding the profile, and the next
  # launch fails with "The requested resource is in use": stop them too.
  Get-Process coucou -ErrorAction SilentlyContinue | ForEach-Object { & taskkill /PID $_.Id /T /F *> $null }
  Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" |
    Where-Object { $_.CommandLine -like "*$ident*" } |
    ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }
  Start-Sleep -Milliseconds 800
}

Stop-Coucou
$log = Join-Path $env:TEMP "coucou-rc-stress.log"
$env:COUCOU_STRESS_CLONES = "$Clones"
$env:RUST_BACKTRACE = "1"
$p = Start-Process -FilePath $exe -PassThru -NoNewWindow -RedirectStandardError $log -RedirectStandardOutput "$log.out"
$deadline = (Get-Date).AddSeconds($Seconds)
$done = $false
while ((Get-Date) -lt $deadline -and -not $p.HasExited) {
  Start-Sleep -Milliseconds 500
  if ((Get-Content $log -Raw -ErrorAction SilentlyContinue) -match "rc stress: done") { $done = $true; break }
}
# A corrupted count can blow up later, on the main thread: stay a while after.
if ($done) { Start-Sleep -Seconds 5; if ($p.HasExited) { $done = $false } }
$text = Get-Content $log -Raw -ErrorAction SilentlyContinue
$exited = $p.HasExited
$code = if ($exited -and $null -ne $p.ExitCode) { $p.ExitCode } else { "?" }
Stop-Coucou
Remove-Item Env:COUCOU_STRESS_CLONES

if ($text -match "resource is in use") {
  # With clones running this is a symptom, not a lock: the corrupted runner makes
  # WebView2 creation fail (a 0-clone run on the same profile starts fine).
  if ($Clones -eq 0) { Write-Output "INVALID: WebView2 profile locked, the run never started."; exit 2 }
  Write-Output "CRASHED: webview creation failed (event loop state corrupted by the clones)."
  exit 1
}
if ($done) {
  Write-Output ("SURVIVED: " + (($text -split "`n") | Where-Object { $_ -match "rc stress: done" } | Select-Object -First 1).Trim())
  exit 0
}
if ($exited) {
  $why = (($text -split "`n") | Where-Object { $_ -match "precondition|panicked|inc_strong|dec_strong" } | Select-Object -First 2) -join " | "
  Write-Output ("CRASHED: exit code $code. " + $(if ($why) { $why.Trim() } else { "aborted without a message (Rc abort is a ud2 / illegal instruction)" }))
  exit 1
}
Write-Output "TIMEOUT: still running after $Seconds s without finishing the stress."
exit 3
