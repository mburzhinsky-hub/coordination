$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$ConfigPath = Join-Path $PSScriptRoot "config.local.json"
$PidPath = Join-Path $RepoRoot ".shared-server.pid"
$SupervisorPidPath = Join-Path $RepoRoot ".supervisor.pid"
$InstalledCommitPath = Join-Path $RepoRoot ".installed-commit"
$LogPath = Join-Path $RepoRoot "auto-update.log"
$RepoZipUrl = "https://github.com/mburzhinsky-hub/coordination/archive/refs/heads/main.zip"
$AtomUrl = "https://github.com/mburzhinsky-hub/coordination/commits/main.atom"
$CheckSeconds = 60

function Log([string]$Message) {
  $line = ("{0}  {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message)
  Add-Content -Path $LogPath -Value $line -Encoding UTF8
}

function Find-Node {
  $cmd = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($cmd) { return [string]$cmd.Source }
  $programFilesX86 = [Environment]::GetFolderPath("ProgramFilesX86")
  $candidates = @(
    "$env:ProgramFiles\nodejs\node.exe",
    "$programFilesX86\nodejs\node.exe",
    "$env:LOCALAPPDATA\Programs\nodejs\node.exe"
  )
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path $candidate)) { return [string]$candidate }
  }
  throw "Node.js executable was not found."
}

function Get-Config {
  if (-not (Test-Path $ConfigPath)) { throw "server\config.local.json was not found." }
  return (Get-Content $ConfigPath -Raw | ConvertFrom-Json)
}

function Get-AuthHeader($Config) {
  $pair = "$($Config.user):$($Config.password)"
  $token = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($pair))
  return @{ Authorization = "Basic $token" }
}

function Test-Server($Config) {
  try {
    $result = Invoke-RestMethod -Uri "http://127.0.0.1:$($Config.port)/api/health" -Headers (Get-AuthHeader $Config) -TimeoutSec 2
    return $result.shared -eq $true
  } catch {
    return $false
  }
}

function Read-ServerProcess {
  if (-not (Test-Path $PidPath)) { return $null }
  try {
    $pidValue = [int](Get-Content $PidPath -Raw)
    return Get-Process -Id $pidValue -ErrorAction SilentlyContinue
  } catch {
    return $null
  }
}

function Start-Server($NodePath, $Config) {
  if (Test-Server $Config) { return (Read-ServerProcess) }

  $stdout = Join-Path $RepoRoot "shared-server.log"
  $stderr = Join-Path $RepoRoot "shared-server-error.log"
  $process = Start-Process -FilePath $NodePath -ArgumentList @("server\server.js") -WorkingDirectory $RepoRoot -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
  Set-Content -Path $PidPath -Value $process.Id -Encoding ASCII

  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-Server $Config) {
      Log ("Server started. PID " + $process.Id)
      return $process
    }
    if ($process.HasExited) { break }
  }
  throw "Node server failed to start."
}

function Stop-Server {
  $process = Read-ServerProcess
  if ($process) {
    try {
      Stop-Process -Id $process.Id -Force -ErrorAction Stop
      try { $process.WaitForExit() } catch {}
      Log ("Server stopped. PID " + $process.Id)
    } catch {
      Log ("Could not stop server PID " + $process.Id + ": " + $_.Exception.Message)
    }
  }
  Remove-Item $PidPath -Force -ErrorAction SilentlyContinue
}

function Get-RemoteCommit {
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $response = Invoke-WebRequest -UseBasicParsing -Uri $AtomUrl -TimeoutSec 15
    [xml]$feed = $response.Content
    $entry = @($feed.feed.entry)[0]
    if (-not $entry) { return $null }
    $id = [string]$entry.id
    if ($id -match '([0-9a-f]{40})$') { return $Matches[1] }
  } catch {
    Log ("Update check failed: " + $_.Exception.Message)
  }
  return $null
}

function Get-InstalledCommit {
  if (-not (Test-Path $InstalledCommitPath)) { return $null }
  try { return (Get-Content $InstalledCommitPath -Raw).Trim() } catch { return $null }
}

function Set-InstalledCommit([string]$Sha) {
  Set-Content -Path $InstalledCommitPath -Value $Sha -Encoding ASCII
}

function Copy-Tree([string]$Source, [string]$Destination) {
  New-Item -ItemType Directory -Path $Destination -Force | Out-Null
  $sourceRoot = (Resolve-Path $Source).Path.TrimEnd('\')
  Get-ChildItem -LiteralPath $Source -Recurse -Force | ForEach-Object {
    $relative = $_.FullName.Substring($sourceRoot.Length).TrimStart('\')
    $target = Join-Path $Destination $relative
    if ($_.PSIsContainer) {
      New-Item -ItemType Directory -Path $target -Force | Out-Null
    } else {
      $parent = Split-Path -Parent $target
      if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
      Copy-Item -LiteralPath $_.FullName -Destination $target -Force
    }
  }
}

function Backup-Code([string]$BackupRoot) {
  New-Item -ItemType Directory -Path $BackupRoot -Force | Out-Null
  $exclude = @(
    "shared-data",
    ".git",
    ".supervisor.pid",
    ".shared-server.pid",
    ".installed-commit",
    "shared-server.log",
    "shared-server-error.log",
    "auto-update.log",
    "SHARE_WITH_COLLEAGUE.txt"
  )
  Get-ChildItem -LiteralPath $RepoRoot -Force | Where-Object { $exclude -notcontains $_.Name } | ForEach-Object {
    if ($_.PSIsContainer) {
      Copy-Tree $_.FullName (Join-Path $BackupRoot $_.Name)
    } else {
      Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $BackupRoot $_.Name) -Force
    }
  }
}

function Restore-Code([string]$BackupRoot) {
  if (Test-Path $BackupRoot) { Copy-Tree $BackupRoot $RepoRoot }
}

function Apply-Update([string]$RemoteSha, [string]$NodePath, $Config) {
  $tempBase = Join-Path $env:TEMP ("ito-coordination-update-" + [Guid]::NewGuid().ToString("N"))
  $zipPath = Join-Path $tempBase "main.zip"
  $extractPath = Join-Path $tempBase "extract"
  $backupPath = Join-Path $tempBase "backup"
  New-Item -ItemType Directory -Path $tempBase -Force | Out-Null

  try {
    Log ("Downloading update " + $RemoteSha)
    Invoke-WebRequest -UseBasicParsing -Uri $RepoZipUrl -OutFile $zipPath -TimeoutSec 60
    Expand-Archive -Path $zipPath -DestinationPath $extractPath -Force
    $source = Join-Path $extractPath "coordination-main"

    if (-not (Test-Path (Join-Path $source "server\server.js"))) {
      throw "Downloaded package is incomplete."
    }

    Backup-Code $backupPath
    Stop-Server

    try {
      Copy-Tree $source $RepoRoot
      Set-InstalledCommit $RemoteSha
      Start-Server $NodePath $Config | Out-Null
      Log ("Update applied successfully: " + $RemoteSha)
    } catch {
      Log ("Update apply failed. Rolling back: " + $_.Exception.Message)
      Restore-Code $backupPath
      Start-Server $NodePath $Config | Out-Null
      throw
    }
  } finally {
    Remove-Item $tempBase -Recurse -Force -ErrorAction SilentlyContinue
  }
}

$mutex = $null
try {
  $createdNew = $false
  $mutex = New-Object System.Threading.Mutex($true, "Local\ITOCoordinationSupervisor", [ref]$createdNew)
  if (-not $createdNew) { exit 0 }

  Set-Content -Path $SupervisorPidPath -Value $PID -Encoding ASCII
  Log ("Supervisor started. PID " + $PID)

  $node = Find-Node
  $config = Get-Config
  Start-Server $node $config | Out-Null

  $remote = Get-RemoteCommit
  if ($remote -and -not (Get-InstalledCommit)) {
    Set-InstalledCommit $remote
    Log ("Initial installed commit recorded: " + $remote)
  }

  while ($true) {
    Start-Sleep -Seconds $CheckSeconds

    if (-not (Test-Server $config)) {
      try { Start-Server $node $config | Out-Null }
      catch { Log ("Server restart failed: " + $_.Exception.Message) }
    }

    $remote = Get-RemoteCommit
    if (-not $remote) { continue }

    $installed = Get-InstalledCommit
    if (-not $installed) {
      Set-InstalledCommit $remote
      continue
    }

    if ($remote -ne $installed) {
      try { Apply-Update $remote $node $config }
      catch { Log ("Automatic update failed; current installation was kept/restored: " + $_.Exception.Message) }
    }
  }
} catch {
  Log ("Supervisor fatal error: " + $_.Exception.Message)
  exit 1
} finally {
  Remove-Item $SupervisorPidPath -Force -ErrorAction SilentlyContinue
  if ($mutex) {
    try { $mutex.ReleaseMutex() | Out-Null } catch {}
    $mutex.Dispose()
  }
}
