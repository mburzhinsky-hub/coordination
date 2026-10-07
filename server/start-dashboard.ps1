$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$ConfigPath = Join-Path $PSScriptRoot "config.local.json"
$SharePath = Join-Path $RepoRoot "SHARE_WITH_COLLEAGUE.txt"
$PidPath = Join-Path $RepoRoot ".shared-server.pid"
$StdOutLog = Join-Path $RepoRoot "shared-server.log"
$StdErrLog = Join-Path $RepoRoot "shared-server-error.log"
$FirewallRule = "ITO Coordination Shared Dashboard"

function Write-Step([string]$Text) {
  Write-Host ""
  Write-Host "==> $Text" -ForegroundColor Cyan
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
    if ($candidate -and (Test-Path $candidate)) { return $candidate }
  }
  return $null
}

function Ensure-Node {
  $node = Find-Node
  if ($node) { return $node }

  Write-Step "Node.js not found. Installing Node.js LTS"
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if (-not $winget) {
    throw "Neither Node.js nor winget was found. Install Node.js LTS from https://nodejs.org and run START_DASHBOARD.cmd again."
  }

  & $winget.Source install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements | Out-Host
  if ($LASTEXITCODE -ne 0) {
    throw "Automatic Node.js installation failed."
  }

  $env:Path = "$env:Path;$env:ProgramFiles\nodejs"
  $node = Find-Node
  if (-not $node) {
    throw "Node.js was installed, but this shell cannot see it yet. Close this window and run START_DASHBOARD.cmd again."
  }
  return $node
}

function New-StrongPassword {
  $bytes = New-Object byte[] 18
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  return ([Convert]::ToBase64String($bytes).TrimEnd("=")).Replace("+","A").Replace("/","B")
}

function Test-PortFree([int]$Port) {
  $listener = $null
  try {
    $listener = New-Object System.Net.Sockets.TcpListener([Net.IPAddress]::Loopback, $Port)
    $listener.Start()
    return $true
  } catch {
    return $false
  } finally {
    if ($listener) { try { $listener.Stop() } catch {} }
  }
}

function Find-FreePort {
  foreach ($port in 8787..8797) {
    if (Test-PortFree $port) { return $port }
  }
  throw "Ports 8787-8797 are busy. Free one of them and run again."
}

function Ensure-Config {
  if (Test-Path $ConfigPath) {
    return (Get-Content $ConfigPath -Raw | ConvertFrom-Json)
  }

  Write-Step "First run. Creating shared configuration"
  $port = Find-FreePort
  $password = New-StrongPassword
  $config = [ordered]@{
    host = "0.0.0.0"
    port = $port
    user = "ito"
    password = $password
    dataDir = "shared-data"
  }
  $config | ConvertTo-Json | Set-Content -Path $ConfigPath -Encoding UTF8
  return [pscustomobject]$config
}

function Get-AuthHeader($Config) {
  $pair = "$($Config.user):$($Config.password)"
  $token = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($pair))
  return @{ Authorization = "Basic $token" }
}

function Test-OurServer($Config) {
  try {
    $result = Invoke-RestMethod -Uri "http://127.0.0.1:$($Config.port)/api/health" -Headers (Get-AuthHeader $Config) -TimeoutSec 2
    return $result.shared -eq $true
  } catch {
    return $false
  }
}

function Ensure-Firewall([int]$Port) {
  try {
    $exists = Get-NetFirewallRule -DisplayName $FirewallRule -ErrorAction SilentlyContinue
    if ($exists) { return }
  } catch {}

  Write-Step "Configuring Windows Firewall. UAC may ask for approval"
  $command = @"
Get-NetFirewallRule -DisplayName '$FirewallRule' -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName '$FirewallRule' -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -Profile Any -RemoteAddress 'LocalSubnet','100.64.0.0/10' | Out-Null
"@
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
  try {
    $process = Start-Process powershell.exe -Verb RunAs -ArgumentList "-NoProfile -EncodedCommand $encoded" -Wait -PassThru
    if ($process.ExitCode -ne 0) {
      Write-Warning "Could not add the Firewall rule. Local access may still work, but another PC might be blocked by Windows Firewall."
    }
  } catch {
    Write-Warning "Firewall setup was skipped: $($_.Exception.Message)"
  }
}

function Start-SharedServer($NodePath, $Config) {
  if (Test-OurServer $Config) {
    Write-Host "Server is already running." -ForegroundColor Green
    return
  }

  if (-not (Test-PortFree ([int]$Config.port))) {
    throw "Port $($Config.port) is already used by another application. Close it or remove server\config.local.json and run again."
  }

  Write-Step "Starting shared server"
  if (Test-Path $StdOutLog) { Remove-Item $StdOutLog -Force -ErrorAction SilentlyContinue }
  if (Test-Path $StdErrLog) { Remove-Item $StdErrLog -Force -ErrorAction SilentlyContinue }

  $process = Start-Process -FilePath $NodePath -ArgumentList @("server\server.js") -WorkingDirectory $RepoRoot -WindowStyle Hidden -RedirectStandardOutput $StdOutLog -RedirectStandardError $StdErrLog -PassThru
  Set-Content -Path $PidPath -Value $process.Id -Encoding ASCII

  $ready = $false
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-OurServer $Config) { $ready = $true; break }
    if ($process.HasExited) { break }
  }

  if (-not $ready) {
    $errorText = ""
    if (Test-Path $StdErrLog) { $errorText = Get-Content $StdErrLog -Raw -ErrorAction SilentlyContinue }
    throw "The server did not start. $errorText"
  }
  Write-Host "Server started." -ForegroundColor Green
}

function Start-Supervisor {
  $supervisor = Join-Path $PSScriptRoot "supervisor.ps1"
  if (-not (Test-Path $supervisor)) {
    Write-Warning "Auto-update supervisor was not found."
    return
  }

  $existing = $null
  $supervisorPidPath = Join-Path $RepoRoot ".supervisor.pid"
  if (Test-Path $supervisorPidPath) {
    try {
      $existingPid = [int](Get-Content $supervisorPidPath -Raw)
      $existing = Get-Process -Id $existingPid -ErrorAction SilentlyContinue
    } catch {}
  }
  if ($existing) { return }

  Start-Process powershell.exe -ArgumentList @(
    "-NoProfile",
    "-WindowStyle", "Hidden",
    "-ExecutionPolicy", "Bypass",
    "-File", $supervisor
  ) -WorkingDirectory $RepoRoot -WindowStyle Hidden | Out-Null
}

function Get-LanIPv4 {
  try {
    $routes = Get-NetRoute -AddressFamily IPv4 -DestinationPrefix "0.0.0.0/0" -ErrorAction Stop | Sort-Object RouteMetric
    foreach ($route in $routes) {
      $addresses = Get-NetIPAddress -AddressFamily IPv4 -InterfaceIndex $route.InterfaceIndex -ErrorAction SilentlyContinue
      foreach ($address in $addresses) {
        $ip = $address.IPAddress
        if ($ip -match '^10\.' -or $ip -match '^192\.168\.' -or $ip -match '^172\.(1[6-9]|2[0-9]|3[0-1])\.') {
          return $ip
        }
      }
    }
  } catch {}
  return $null
}

function Get-TailscaleIPv4 {
  $tailscale = Get-Command tailscale -ErrorAction SilentlyContinue
  if (-not $tailscale) {
    $candidate = "$env:ProgramFiles\Tailscale\tailscale.exe"
    if (Test-Path $candidate) { $tailscale = Get-Item $candidate }
  }
  if (-not $tailscale) { return $null }

  try {
    $ip = (& $tailscale.Source ip -4 2>$null | Select-Object -First 1)
    if ($ip) {
      $ip = $ip.Trim()
      if ($ip -match '^100\.') { return $ip }
    }
  } catch {}
  return $null
}

function Ensure-Autostart {
  try {
    $startup = [Environment]::GetFolderPath("Startup")
    $cmdPath = Join-Path $startup "ITO Coordination Shared Server.cmd"
    $runner = Join-Path $PSScriptRoot "run-shared.ps1"
    $logPath = Join-Path $RepoRoot "auto-update.log"
    $cmd = @"
@echo off
cd /d "$RepoRoot"
start "" /min powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "$runner" >> "$logPath" 2>&1
"@
    Set-Content -Path $cmdPath -Value $cmd -Encoding ASCII
  } catch {
    Write-Warning "Could not install autostart: $($_.Exception.Message)"
  }
}

function Try-GitUpdate {
  $git = Get-Command git -ErrorAction SilentlyContinue
  if (-not $git -or -not (Test-Path (Join-Path $RepoRoot ".git"))) { return }
  try {
    $status = (& $git.Source -C $RepoRoot status --porcelain)
    if (-not $status) {
      Write-Step "Checking dashboard updates"
      & $git.Source -C $RepoRoot pull --ff-only | Out-Host
    }
  } catch {
    Write-Warning "Git auto-update skipped: $($_.Exception.Message)"
  }
}

try {
  [Console]::OutputEncoding = [Text.Encoding]::UTF8
  Write-Host ""
  Write-Host "ITO COORDINATION - SHARED DASHBOARD" -ForegroundColor White
  Write-Host "===================================" -ForegroundColor DarkGray

  $node = [string](@(Ensure-Node) | Select-Object -Last 1)
  if (-not $node -or -not (Test-Path $node)) {
    throw "Node.js executable path could not be resolved."
  }
  Try-GitUpdate
  $config = Ensure-Config
  Ensure-Firewall ([int]$config.port)
  Start-SharedServer $node $config
  Start-Supervisor
  Ensure-Autostart

  $localUrl = "http://localhost:$($config.port)"
  $tailscaleIp = Get-TailscaleIPv4
  $lanIp = Get-LanIPv4

  $tailscaleUrl = if ($tailscaleIp) { ("http://{0}:{1}" -f $tailscaleIp, $config.port) } else { $null }
  $lanUrl = if ($lanIp) { ("http://{0}:{1}" -f $lanIp, $config.port) } else { $null }
  $shareUrl = if ($tailscaleUrl) { $tailscaleUrl } elseif ($lanUrl) { $lanUrl } else { $localUrl }

  $access = @"
ITO Coordination - shared dashboard
===================================

COLLEAGUE URL:
$shareUrl

Login:
$($config.user)

Password:
$($config.password)

Local URL on server PC:
$localUrl

$(if ($tailscaleUrl) { "Tailscale: $tailscaleUrl" } else { "Tailscale: not detected. Install Tailscale on both PCs for access from different networks." })
$(if ($lanUrl) { "LAN: $lanUrl" } else { "LAN: address not detected." })

IMPORTANT:
- Share this URL and password only with the intended colleague.
- Do not configure router port forwarding for port $($config.port).
- Use Tailscale for access from another network.
- Shared data directory: $RepoRoot\shared-data
"@
  Set-Content -Path $SharePath -Value $access -Encoding UTF8

  try { Set-Clipboard -Value $shareUrl } catch {}

  Write-Host ""
  Write-Host "READY" -ForegroundColor Green
  Write-Host "-----"
  Write-Host "Your dashboard:     $localUrl"
  Write-Host "Colleague URL:      $shareUrl" -ForegroundColor Yellow
  Write-Host "Login:              $($config.user)"
  Write-Host "Password:           $($config.password)"
  Write-Host ""
  Write-Host "Access details are also saved to:" -ForegroundColor DarkGray
  Write-Host $SharePath
  Write-Host ""

  if (-not $tailscaleUrl) {
    Write-Host "The colleague URL currently works only in the same local network." -ForegroundColor DarkYellow
    Write-Host "For different networks, install Tailscale on both PCs and run START_DASHBOARD.cmd again."
    Write-Host ""
  }

  Write-Host "The colleague URL was copied to clipboard."
  Write-Host "Opening dashboard..."
  Start-Process $localUrl

  Write-Host ""
  Write-Host "You can close this window. The server continues in the background." -ForegroundColor DarkGray
  Write-Host "It will also start automatically after Windows sign-in." -ForegroundColor DarkGray
  Read-Host "Press Enter to close this window" | Out-Null
} catch {
  Write-Host ""
  Write-Host "ERROR" -ForegroundColor Red
  Write-Host $_.Exception.Message -ForegroundColor Red
  Write-Host ""
  if (Test-Path $StdErrLog) {
    Write-Host "---- shared-server-error.log ----" -ForegroundColor DarkYellow
    Get-Content $StdErrLog -Tail 80
    Write-Host "---------------------------------" -ForegroundColor DarkYellow
  }
  Read-Host "Press Enter to close this window" | Out-Null
  exit 1
}
