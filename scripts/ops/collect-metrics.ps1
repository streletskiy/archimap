param([string]$ComposeRoot = 'C:\Users\Bonmucho\Documents\archimap', [string]$OutputRoot = 'C:\ProgramData\Archimap\metrics')
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $OutputRoot | Out-Null
$root = (Resolve-Path -LiteralPath $OutputRoot).Path
$line = Get-Content -LiteralPath (Join-Path $ComposeRoot '.env') | Where-Object { $_ -match '^METRICS_TOKEN=' } | Select-Object -Last 1
if (-not $line) { throw 'Metrics token is not configured' }
$token = $line.Substring('METRICS_TOKEN='.Length).Trim().Trim('"').Trim("'")
$response = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3252/metrics' -Headers @{ Authorization = "Bearer $token" } -TimeoutSec 20
$target = Join-Path $root ((Get-Date -Format 'yyyyMMdd-HHmm') + '.prom')
[IO.File]::WriteAllText($target, $response.Content, (New-Object Text.UTF8Encoding($false)))
$ready = Invoke-RestMethod -Uri 'http://127.0.0.1:3252/readyz' -TimeoutSec 5
if (-not $ready.ok) { throw 'Archimap is not ready' }
if ($response.Content -match '(?m)^archimap_sync_worker_up 0$') { throw 'Sync worker unavailable' }
Get-ChildItem -LiteralPath $root -File -Filter '*.prom' | Where-Object {
  $_.Name -match '^\d{8}-\d{4}\.prom$' -and $_.LastWriteTime -lt (Get-Date).AddDays(-7)
} | ForEach-Object {
  if ($_.DirectoryName -ne $root) { throw 'Metrics retention path escaped root' }
  Remove-Item -LiteralPath $_.FullName
}
