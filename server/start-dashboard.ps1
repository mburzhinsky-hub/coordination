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
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
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

  Write-Step "Node.js не найден. Устанавливаю Node.js LTS"
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if (-not $winget) {
    throw "Не найден ни Node.js, ни winget. Установите Node.js LTS с https://nodejs.org и запустите START_DASHBOARD.cmd снова."
  }

  & $winget.Source install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -ne 0) {
    throw "Не удалось автоматически установить Node.js через winget."
  }

  $env:Path = "$env:Path;$env:ProgramFiles\nodejs"
  $node = Find-Node
  if (-not $node) {
    throw "Node.js установлен, но текущая сессия его ещё не видит. Закройте это окно и запустите START_DASHBOARD.cmd ещё раз."
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
  throw "Порты 8787-8797 заняты. Освободите один из них и запустите снова."
}

function Ensure-Config {
  if (Test-Path $ConfigPath) {
    return (Get-Content $ConfigPath -Raw | ConvertFrom-Json)
  }

  Write-Step "Первый запуск. Создаю общую конфигурацию"
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

  Write-Step "Настраиваю Windows Firewall. Может появиться запрос UAC"
  $command = @"
Get-NetFirewallRule -DisplayName '$FirewallRule' -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName '$FirewallRule' -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -Profile Any -RemoteAddress 'LocalSubnet','100.64.0.0/10' | Out-Null
"@
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
  try {
    $process = Start-Process powershell.exe -Verb RunAs -ArgumentList "-NoProfile -EncodedCommand $encoded" -Wait -PassThru
    if ($process.ExitCode -ne 0) {
      Write-Warning "Не удалось добавить Firewall rule. Dashboard будет работать на этом ПК, но доступ коллеги может блокироваться Windows Firewall."
    }
  } catch {
    Write-Warning "Настройка Firewall пропущена: $($_.Exception.Message)"
  }
}

function Start-SharedServer($NodePath, $Config) {
  if (Test-OurServer $Config) {
    Write-Host "Сервер уже работает." -ForegroundColor Green
    return
  }

  if (-not (Test-PortFree ([int]$Config.port))) {
    throw "Порт $($Config.port) уже занят другим приложением. Закройте его или удалите server\config.local.json и запустите снова."
  }

  Write-Step "Запускаю общий сервер"
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
    throw "Сервер не запустился. $errorText"
  }
  Write-Host "Сервер запущен." -ForegroundColor Green
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
    if (Test-Path $cmdPath) { return }

    $runner = Join-Path $PSScriptRoot "run-shared.ps1"
    $logPath = Join-Path $RepoRoot "shared-server.log"
    $cmd = @"
@echo off
cd /d "$RepoRoot"
powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "$runner" >> "$logPath" 2>&1
"@
    Set-Content -Path $cmdPath -Value $cmd -Encoding ASCII
  } catch {
    Write-Warning "Не удалось установить автозапуск: $($_.Exception.Message)"
  }
}

function Try-GitUpdate {
  $git = Get-Command git -ErrorAction SilentlyContinue
  if (-not $git -or -not (Test-Path (Join-Path $RepoRoot ".git"))) { return }
  try {
    $status = (& $git.Source -C $RepoRoot status --porcelain)
    if (-not $status) {
      Write-Step "Проверяю обновления dashboard"
      & $git.Source -C $RepoRoot pull --ff-only | Out-Host
    }
  } catch {
    Write-Warning "Автообновление Git пропущено: $($_.Exception.Message)"
  }
}

try {
  [Console]::OutputEncoding = [Text.Encoding]::UTF8
  Write-Host ""
  Write-Host "ITO COORDINATION - ОБЩИЙ DASHBOARD" -ForegroundColor White
  Write-Host "==================================" -ForegroundColor DarkGray

  $node = Ensure-Node
  Try-GitUpdate
  $config = Ensure-Config
  Ensure-Firewall ([int]$config.port)
  Start-SharedServer $node $config
  Ensure-Autostart

  $localUrl = "http://localhost:$($config.port)"
  $tailscaleIp = Get-TailscaleIPv4
  $lanIp = Get-LanIPv4

  $tailscaleUrl = if ($tailscaleIp) { ("http://{0}:{1}" -f $tailscaleIp, $config.port) } else { $null }
  $lanUrl = if ($lanIp) { ("http://{0}:{1}" -f $lanIp, $config.port) } else { $null }
  $shareUrl = if ($tailscaleUrl) { $tailscaleUrl } elseif ($lanUrl) { $lanUrl } else { $localUrl }

  $access = @"
ITO Coordination - общий dashboard
==================================

ССЫЛКА ДЛЯ КОЛЛЕГИ:
$shareUrl

Логин:
$($config.user)

Пароль:
$($config.password)

Локально на серверном ПК:
$localUrl

$(if ($tailscaleUrl) { "Tailscale: $tailscaleUrl" } else { "Tailscale: не обнаружен. Для доступа из другой сети установите Tailscale на оба компьютера." })
$(if ($lanUrl) { "Локальная сеть: $lanUrl" } else { "Локальная сеть: адрес не определён." })

ВАЖНО:
- Давайте эту ссылку и пароль только сотруднику, которому нужен доступ.
- Не делайте port forwarding порта $($config.port) на роутере.
- Для доступа из другой сети используйте Tailscale.
- Общая база хранится в: $RepoRoot\shared-data
"@
  Set-Content -Path $SharePath -Value $access -Encoding UTF8

  try { Set-Clipboard -Value $shareUrl } catch {}

  Write-Host ""
  Write-Host "ГОТОВО" -ForegroundColor Green
  Write-Host "------"
  Write-Host "Ваш dashboard:      $localUrl"
  Write-Host "Ссылка для коллеги: $shareUrl" -ForegroundColor Yellow
  Write-Host "Логин:              $($config.user)"
  Write-Host "Пароль:             $($config.password)"
  Write-Host ""
  Write-Host "Реквизиты также сохранены в:" -ForegroundColor DarkGray
  Write-Host $SharePath
  Write-Host ""
  if (-not $tailscaleUrl) {
    Write-Host "Сейчас ссылка рассчитана для одной локальной сети." -ForegroundColor DarkYellow
    Write-Host "Для доступа из другой сети установите Tailscale на оба ПК и снова запустите START_DASHBOARD.cmd."
    Write-Host ""
  }
  Write-Host "Ссылка скопирована в буфер обмена."
  Write-Host "Открываю dashboard..."
  Start-Process $localUrl

  Write-Host ""
  Write-Host "Это окно можно закрыть: сервер продолжит работать в фоне." -ForegroundColor DarkGray
  Write-Host "При следующем входе в Windows сервер запустится автоматически." -ForegroundColor DarkGray
  Read-Host "Нажмите Enter, чтобы закрыть это окно" | Out-Null
} catch {
  Write-Host ""
  Write-Host "ОШИБКА" -ForegroundColor Red
  Write-Host $_.Exception.Message -ForegroundColor Red
  Write-Host ""
  Read-Host "Нажмите Enter, чтобы закрыть окно" | Out-Null
  exit 1
}
