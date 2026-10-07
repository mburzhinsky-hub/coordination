$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host "Node.js не найден. Установите Node.js LTS." -ForegroundColor Red
  exit 1
}

$configPath = Join-Path $PSScriptRoot "config.local.json"
if (-not (Test-Path $configPath)) {
  Write-Host "Нет server\config.local.json. Сначала запустите server\setup-windows.ps1." -ForegroundColor Yellow
  exit 1
}

& node "server\server.js"
