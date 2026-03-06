param(
  [Parameter(Mandatory = $true)]
  [string]$Version,

  [string]$Image = "streletskiy/archimap",

  [string]$Platforms = "linux/amd64,linux/arm64",

  [switch]$NoCache,

  [string]$CacheRef,

  [string]$TippecanoeRef = "2.79.0",

  [string]$QuackosmVersion = "0.17.0",

  [string]$DuckdbVersion = "1.4.4",

  [string]$PipVersion = "26.0.1",

  [string]$RuntimeBaseTag = "",

  [string]$Builder = "archimap-multiarch",

  [switch]$SkipBinfmtRepair,

  [switch]$SkipRuntimeBase,

  [switch]$ForceRuntimeBase
)

$ErrorActionPreference = "Stop"
# PowerShell 7 can convert non-zero native exit codes into terminating errors.
# For docker CLI we handle exit codes explicitly via $LASTEXITCODE.
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
  $PSNativeCommandUseErrorActionPreference = $false
}
$env:DOCKER_BUILDKIT = "1"

if ([string]::IsNullOrWhiteSpace($Version)) {
  throw "Version is required. Example: .\scripts\release-docker.ps1 -Version 1.2.3"
}

if ([string]::IsNullOrWhiteSpace($CacheRef)) {
  $CacheRef = "${Image}:buildcache"
}

if ([string]::IsNullOrWhiteSpace($RuntimeBaseTag)) {
  $rawRuntimeBaseTag = "runtime-base-t$TippecanoeRef-q$QuackosmVersion-d$DuckdbVersion-p$PipVersion"
  $RuntimeBaseTag = ($rawRuntimeBaseTag -replace '[^A-Za-z0-9._-]', '-')
}
$RuntimeBaseImage = "${Image}:$RuntimeBaseTag"

function Invoke-Docker {
  param([string[]]$CommandArgs)
  $previous = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    & docker @CommandArgs
    return $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previous
  }
}

function Invoke-DockerCapture {
  param([string[]]$CommandArgs)
  $previous = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $output = & docker @CommandArgs 2>&1
    return @{
      ExitCode = $LASTEXITCODE
      Output = @($output)
    }
  } finally {
    $ErrorActionPreference = $previous
  }
}

function Get-PlatformsFromInspectOutput {
  param([object[]]$InspectOutput)
  $platformsLine = ($InspectOutput | Select-String -Pattern "Platforms:" | Select-Object -First 1)
  if (-not $platformsLine) { return @() }
  return $platformsLine.ToString().Split(":", 2)[1].Split(",") | ForEach-Object { $_.Trim() } | Where-Object { $_ }
}

function Get-MissingPlatforms {
  param([string[]]$TargetPlatforms, [string[]]$AvailablePlatforms)
  return @($TargetPlatforms | Where-Object { $_ -and ($AvailablePlatforms -notcontains $_) })
}

function Wait-BuilderRemoved {
  param(
    [string]$BuilderName,
    [int]$TimeoutSeconds = 20
  )

  $start = Get-Date
  while (((Get-Date) - $start).TotalSeconds -lt $TimeoutSeconds) {
    $probe = Invoke-DockerCapture -CommandArgs @("buildx", "inspect", $BuilderName)
    if ($probe.ExitCode -ne 0) { return $true }
    Start-Sleep -Milliseconds 400
  }
  return $false
}

function Ensure-BuilderCreatedAndSelected {
  param(
    [string]$BuilderName,
    [int]$MaxAttempts = 6
  )

  $createArgs = @("buildx", "create", "--name", $BuilderName, "--driver", "docker-container", "--use")
  $useArgs = @("buildx", "use", $BuilderName)

  for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
    $createResult = Invoke-DockerCapture -CommandArgs $createArgs
    if ($createResult.ExitCode -eq 0) {
      return
    }

    # If create raced with async deletion/existing name, try to select existing builder.
    $useResult = Invoke-DockerCapture -CommandArgs $useArgs
    if ($useResult.ExitCode -eq 0) {
      return
    }

    if ($attempt -lt $MaxAttempts) {
      Start-Sleep -Milliseconds (400 * $attempt)
      continue
    }

    $createOutput = $createResult.Output -join [Environment]::NewLine
    $useOutput = $useResult.Output -join [Environment]::NewLine
    throw "Failed to create or select buildx builder '$BuilderName'.`ncreate:`n$createOutput`nuse:`n$useOutput"
  }
}

function Ensure-BuildxBuilder {
  param(
    [string]$BuilderName,
    [string[]]$TargetPlatforms,
    [bool]$AllowBinfmtRepair
  )

  Write-Host "Ensuring buildx builder: $BuilderName" -ForegroundColor Gray

  $inspectArgs = @("buildx", "inspect", $BuilderName)
  $inspectResult = Invoke-DockerCapture -CommandArgs $inspectArgs
  $hasBuilder = ($inspectResult.ExitCode -eq 0)

  if (-not $hasBuilder) {
    Ensure-BuilderCreatedAndSelected -BuilderName $BuilderName
  } else {
    $useArgs = @("buildx", "use", $BuilderName)
    if ((Invoke-Docker -CommandArgs $useArgs) -ne 0) {
      throw "Failed to switch to buildx builder '$BuilderName'"
    }
  }

  Write-Host "Bootstrapping builder..." -ForegroundColor Gray
  $bootstrapResult = Invoke-DockerCapture -CommandArgs @("buildx", "inspect", "--bootstrap")
  if ($bootstrapResult.ExitCode -ne 0) {
    throw "Failed to bootstrap buildx builder '$BuilderName'.`n$($bootstrapResult.Output -join [Environment]::NewLine)"
  }

  $inspectAfterBootstrapResult = Invoke-DockerCapture -CommandArgs @("buildx", "inspect", $BuilderName)
  if ($inspectAfterBootstrapResult.ExitCode -ne 0) {
    throw "Failed to inspect buildx builder '$BuilderName' after bootstrap.`n$($inspectAfterBootstrapResult.Output -join [Environment]::NewLine)"
  }
  $inspectAfterBootstrap = $inspectAfterBootstrapResult.Output

  $availablePlatforms = Get-PlatformsFromInspectOutput -InspectOutput $inspectAfterBootstrap
  $missingPlatforms = Get-MissingPlatforms -TargetPlatforms $TargetPlatforms -AvailablePlatforms $availablePlatforms
  if ($missingPlatforms.Count -eq 0) {
    return
  }

  if (-not $AllowBinfmtRepair) {
    throw "Builder '$BuilderName' does not support required platforms: $($missingPlatforms -join ', '). Available: $($availablePlatforms -join ', ')"
  }

  Write-Host "Missing platforms detected: $($missingPlatforms -join ', '). Trying to install binfmt..." -ForegroundColor Yellow
  $binfmtArgs = @("run", "--privileged", "--rm", "tonistiigi/binfmt", "--install", "all")
  $binfmtResult = Invoke-DockerCapture -CommandArgs $binfmtArgs
  if ($binfmtResult.ExitCode -ne 0) {
    Write-Host "binfmt install command returned exit code $($binfmtResult.ExitCode); continuing with platform verification..." -ForegroundColor Yellow
  }

  $bootstrapResult2 = Invoke-DockerCapture -CommandArgs @("buildx", "inspect", "--bootstrap")
  if ($bootstrapResult2.ExitCode -ne 0) {
    throw "Builder bootstrap failed after binfmt install.`n$($bootstrapResult2.Output -join [Environment]::NewLine)"
  }

  $inspectAfterRepairResult = Invoke-DockerCapture -CommandArgs @("buildx", "inspect", $BuilderName)
  if ($inspectAfterRepairResult.ExitCode -ne 0) {
    throw "Failed to inspect buildx builder '$BuilderName' after binfmt install.`n$($inspectAfterRepairResult.Output -join [Environment]::NewLine)"
  }
  $inspectAfterRepair = $inspectAfterRepairResult.Output
  $availablePlatforms2 = Get-PlatformsFromInspectOutput -InspectOutput $inspectAfterRepair

  $stillMissing = Get-MissingPlatforms -TargetPlatforms $TargetPlatforms -AvailablePlatforms $availablePlatforms2
  if ($stillMissing.Count -gt 0) {
    Write-Host "Recreating builder '$BuilderName' to pick up newly installed binfmt..." -ForegroundColor Yellow
    $null = Invoke-DockerCapture -CommandArgs @("buildx", "rm", $BuilderName)
    if (-not (Wait-BuilderRemoved -BuilderName $BuilderName -TimeoutSeconds 25)) {
      Write-Host "Builder '$BuilderName' did not disappear in time; proceeding with recreate retries..." -ForegroundColor Yellow
    }
    Ensure-BuilderCreatedAndSelected -BuilderName $BuilderName
    $bootstrapResult3 = Invoke-DockerCapture -CommandArgs @("buildx", "inspect", "--bootstrap")
    if ($bootstrapResult3.ExitCode -ne 0) {
      throw "Failed to bootstrap recreated buildx builder '$BuilderName'.`n$($bootstrapResult3.Output -join [Environment]::NewLine)"
    }
    $inspectAfterRecreateResult = Invoke-DockerCapture -CommandArgs @("buildx", "inspect", $BuilderName)
    if ($inspectAfterRecreateResult.ExitCode -ne 0) {
      throw "Failed to inspect recreated buildx builder '$BuilderName'.`n$($inspectAfterRecreateResult.Output -join [Environment]::NewLine)"
    }
    $availablePlatforms2 = Get-PlatformsFromInspectOutput -InspectOutput $inspectAfterRecreateResult.Output
    $stillMissing = Get-MissingPlatforms -TargetPlatforms $TargetPlatforms -AvailablePlatforms $availablePlatforms2
  }

  if ($stillMissing.Count -gt 0) {
    throw "Builder '$BuilderName' still misses platforms: $($stillMissing -join ', '). Available: $($availablePlatforms2 -join ', ')"
  }
}

function Get-GitBuildMetadata {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $sha = (& git rev-parse --short HEAD 2>$null | Out-String).Trim().ToLowerInvariant()
    $describe = (& git describe --tags --always --dirty 2>$null | Out-String).Trim()
    $allTags = (& git tag --list --sort=-v:refname 2>$null)
  } finally {
    $ErrorActionPreference = $previous
  }

  if ([string]::IsNullOrWhiteSpace($sha) -or [string]::IsNullOrWhiteSpace($describe)) {
    throw "Failed to resolve git metadata (BUILD_SHA/BUILD_DESCRIBE). Ensure this is a git checkout with at least one commit."
  }

  $latestTag = ""
  foreach ($tag in @($allTags)) {
    $candidate = [string]$tag
    if ($candidate -match '^v?\d+\.\d+\.\d+(?:[-+\.][0-9A-Za-z.-]+)?$') {
      $latestTag = $candidate.Trim()
      break
    }
  }

  return @{
    Sha = $sha
    Describe = $describe
    LatestTag = $latestTag
  }
}

$targetPlatforms = $Platforms.Split(",") | ForEach-Object { $_.Trim() } | Where-Object { $_ }
if ($targetPlatforms.Count -eq 0) {
  throw "No target platforms provided. Example: -Platforms linux/amd64,linux/arm64"
}

Ensure-BuildxBuilder -BuilderName $Builder -TargetPlatforms $targetPlatforms -AllowBinfmtRepair (-not $SkipBinfmtRepair)

$gitBuild = Get-GitBuildMetadata
$publishLatest = ($Version.Trim().ToLowerInvariant() -ne "dev")

$tags = @(
  "-t", "${Image}:${Version}"
)

if ($publishLatest) {
  $tags += @("-t", "${Image}:latest")
}

$args = @(
  "buildx", "build",
  "--builder", $Builder,
  "--platform", $Platforms,
  "--build-arg", "TIPPECANOE_REF=$TippecanoeRef",
  "--build-arg", "QUACKOSM_VERSION=$QuackosmVersion",
  "--build-arg", "DUCKDB_VERSION=$DuckdbVersion",
  "--build-arg", "PIP_VERSION=$PipVersion",
  "--build-arg", "RUNTIME_BASE_IMAGE=$RuntimeBaseImage",
  "--build-arg", "BUILD_SHA=$($gitBuild.Sha)",
  "--build-arg", "BUILD_DESCRIBE=$($gitBuild.Describe)",
  "--build-arg", "BUILD_LATEST_TAG=$($gitBuild.LatestTag)"
) + $tags + @("--push")

if ($NoCache) {
  $args += "--no-cache"
} else {
  $args += @("--cache-from", "type=registry,ref=$CacheRef")
  $args += @("--cache-to", "type=registry,ref=$CacheRef,mode=max")
}

$args += "."

if (-not $SkipRuntimeBase) {
  $inspectRuntimeBase = Invoke-DockerCapture -CommandArgs @("buildx", "imagetools", "inspect", $RuntimeBaseImage)
  $runtimeBaseExists = ($inspectRuntimeBase.ExitCode -eq 0)

  if ($ForceRuntimeBase -or -not $runtimeBaseExists) {
    $baseArgs = @(
      "buildx", "build",
      "--builder", $Builder,
      "--platform", $Platforms,
      "--target", "runtime-base",
      "--build-arg", "TIPPECANOE_REF=$TippecanoeRef",
      "--build-arg", "QUACKOSM_VERSION=$QuackosmVersion",
      "--build-arg", "DUCKDB_VERSION=$DuckdbVersion",
      "--build-arg", "PIP_VERSION=$PipVersion",
      "-t", $RuntimeBaseImage,
      "--push"
    )
    if ($NoCache) {
      $baseArgs += "--no-cache"
    } else {
      $baseArgs += @("--cache-from", "type=registry,ref=$CacheRef")
      $baseArgs += @("--cache-to", "type=registry,ref=$CacheRef,mode=max")
    }
    $baseArgs += "."

    if ($ForceRuntimeBase) {
      Write-Host "Force-publishing runtime-base image..." -ForegroundColor Cyan
    } else {
      Write-Host "Publishing runtime-base image (not found in registry)..." -ForegroundColor Cyan
    }
    Write-Host "Runtime base tag: $RuntimeBaseImage" -ForegroundColor Gray
    $previousBase = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
      & docker @baseArgs
      $baseExitCode = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $previousBase
    }
    if ($baseExitCode -ne 0) {
      throw "docker buildx build (runtime-base) failed with exit code $baseExitCode"
    }
  } else {
    Write-Host "Runtime-base image already exists. Skipping rebuild:" -ForegroundColor Green
    Write-Host "  $RuntimeBaseImage" -ForegroundColor Gray
    Write-Host "Use -ForceRuntimeBase to rebuild it explicitly." -ForegroundColor Gray
  }
}

Write-Host "Publishing app image..." -ForegroundColor Cyan
Write-Host "Image: $Image" -ForegroundColor Gray
Write-Host "Version tag: $Version" -ForegroundColor Gray
Write-Host "Runtime base image: $RuntimeBaseImage" -ForegroundColor Gray
Write-Host "Platforms: $Platforms" -ForegroundColor Gray
Write-Host "Tippecanoe ref: $TippecanoeRef" -ForegroundColor Gray
Write-Host "QuackOSM version: $QuackosmVersion" -ForegroundColor Gray
Write-Host "DuckDB version: $DuckdbVersion" -ForegroundColor Gray
Write-Host "pip version: $PipVersion" -ForegroundColor Gray
Write-Host "Build SHA: $($gitBuild.Sha)" -ForegroundColor Gray
Write-Host "Build describe: $($gitBuild.Describe)" -ForegroundColor Gray
if (-not [string]::IsNullOrWhiteSpace($gitBuild.LatestTag)) {
  Write-Host "Build latest tag: $($gitBuild.LatestTag)" -ForegroundColor Gray
}
if ($NoCache) {
  Write-Host "Build cache: disabled (--no-cache)" -ForegroundColor Yellow
} else {
  Write-Host "Build cache ref: $CacheRef" -ForegroundColor Gray
}

$previous = $ErrorActionPreference
$ErrorActionPreference = "Continue"
try {
  & docker @args
  $buildExitCode = $LASTEXITCODE
} finally {
  $ErrorActionPreference = $previous
}

if ($buildExitCode -ne 0) {
  throw "docker buildx build failed with exit code $buildExitCode"
}

Write-Host "Done." -ForegroundColor Green
Write-Host "Published tags:" -ForegroundColor Green
Write-Host "  ${Image}:${Version}" -ForegroundColor Green
if ($publishLatest) {
  Write-Host "  ${Image}:latest" -ForegroundColor Green
}
Write-Host "  $RuntimeBaseImage" -ForegroundColor Green
Write-Host "Server deploy (layer-based):" -ForegroundColor Cyan
Write-Host "  docker pull ${Image}:${Version}" -ForegroundColor Gray
Write-Host "  docker compose up -d" -ForegroundColor Gray
