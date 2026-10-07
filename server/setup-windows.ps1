$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $PSScriptRoot "config.local.json"

Write-Host ""
Write-Host "ITO Coordination - настройка общего доступа" -ForegroundColor Cyan
Write-Host "------------------------------------------------"

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host "Node.js не найден. Установите Node.js LTS и запустите этот скрипт снова." -ForegroundColor Red
  exit 1
}

$versionText = (& node -v).TrimStart("v")
$major = [int]($versionText.Split(".")[0])
if ($major -lt 18) {
  Write-Host "Нужен Node.js 18 или новее. Сейчас: $versionText" -ForegroundColor Red
  exit 1
}

$user = Read-Host "Логин [ito]"
if ([string]::IsNullOrWhiteSpace($user)) { $user = "ito" }

$secure = Read-Host "Пароль (минимум 10 символов)" -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
}
if ($password.Length -lt 10) {
  Write-Host "Пароль слишком короткий." -ForegroundColor Red
  exit 1
}

$portText = Read-Host "Порт [8787]"
if ([string]::IsNullOrWhiteSpace($portText)) { $port = 8787 } else { $port = [int]$portText }

$config = [ordered]@{
  host = "0.0.0.0"
  port = $port
  user = $user
  password = $password
  dataDir = "shared-data"
}

$config | ConvertTo-Json | Set-Content -Path $configPath -Encoding UTF8

Write-Host ""
Write-Host "Готово. Конфигурация сохранена локально:" -ForegroundColor Green
Write-Host $configPath
Write-Host ""
Write-Host "Теперь запустите:"
Write-Host "  powershell -ExecutionPolicy Bypass -File server\run-shared.ps1"
Write-Host ""
Write-Host "После запуска откройте http://localhost:$port"
