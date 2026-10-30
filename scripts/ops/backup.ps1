param(
  [string]$BackupRoot = 'C:\ProgramData\Archimap\backups\daily',
  [string]$ComposeRoot = 'C:\Users\Bonmucho\Documents\archimap',
  [int]$RetentionDays = 3
)
$ErrorActionPreference = 'Stop'
$docker = 'C:\Program Files\Docker\Docker\resources\bin\docker.exe'
$endpoint = 'npipe:////./pipe/docker_engine'
$mutex = New-Object Threading.Mutex($false, 'Global\ArchimapDatabaseBackup')
if (-not $mutex.WaitOne(0)) { throw 'Backup already running' }
try {
  New-Item -ItemType Directory -Force -Path $BackupRoot | Out-Null
  $root = (Resolve-Path -LiteralPath $BackupRoot).Path
  & icacls $root /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
  if ($LASTEXITCODE) { throw 'Cannot protect backup directory' }
  $name = 'archimap-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.dump'
  $target = Join-Path $root $name
  & $docker --host $endpoint exec archimap-postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc -Z 3 --exclude-schema="region_sync_stage_*" -f /tmp/archimap-scheduled.dump'
  if ($LASTEXITCODE) { throw 'pg_dump failed' }
  & $docker --host $endpoint exec archimap-postgres pg_restore --list /tmp/archimap-scheduled.dump | Out-Null
  if ($LASTEXITCODE) { throw 'Backup archive validation failed' }
  & $docker --host $endpoint cp archimap-postgres:/tmp/archimap-scheduled.dump "$target.partial"
  if ($LASTEXITCODE) { throw 'Backup transfer failed' }
  Move-Item -LiteralPath "$target.partial" -Destination $target
  $hash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash
  $configuration = @()
  foreach ($entry in @(@{source='.env';suffix='.env'},@{source='docker-compose.yml';suffix='.compose.yml'})) {
    $configName = $name.Replace('.dump',$entry.suffix)
    $configPath = Join-Path $root $configName
    Copy-Item -LiteralPath (Join-Path $ComposeRoot $entry.source) -Destination $configPath
    $configuration += @{file=$configName;sha256=(Get-FileHash -LiteralPath $configPath -Algorithm SHA256).Hash;bytes=(Get-Item -LiteralPath $configPath).Length}
  }
  $manifest = @{ file = $name; sha256 = $hash; bytes = (Get-Item -LiteralPath $target).Length; createdUtc = [DateTime]::UtcNow.ToString('o'); configuration=$configuration }
  $manifest | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $root 'latest.json.partial') -Encoding UTF8
  Move-Item -LiteralPath (Join-Path $root 'latest.json.partial') -Destination (Join-Path $root 'latest.json') -Force
  Get-ChildItem -LiteralPath $root -File -Filter 'archimap-*' | Where-Object {
    $_.Name -match '^archimap-\d{8}-\d{6}\.(dump|env|compose\.yml)$' -and $_.LastWriteTime -lt (Get-Date).AddDays(-[Math]::Max(2, $RetentionDays))
  } | ForEach-Object {
    if ($_.DirectoryName -ne $root) { throw 'Backup retention path escaped root' }
    Remove-Item -LiteralPath $_.FullName
  }
  $manifest | ConvertTo-Json -Compress
} finally { $mutex.ReleaseMutex(); $mutex.Dispose() }
