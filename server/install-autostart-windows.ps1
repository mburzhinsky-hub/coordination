$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$runner = Join-Path $PSScriptRoot "run-shared.ps1"
$config = Join-Path $PSScriptRoot "config.local.json"

if (-not (Test-Path $config)) {
  Write-Host "Сначала запустите server\setup-windows.ps1." -ForegroundColor Yellow
  exit 1
}

$startup = [Environment]::GetFolderPath("Startup")
$cmdPath = Join-Path $startup "ITO-Coordination-Shared.cmd"
$logPath = Join-Path $repoRoot "shared-server.log"

$cmd = @"
@echo off
cd /d "$repoRoot"
powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "$runner" >> "$logPath" 2>&1
"@

Set-Content -Path $cmdPath -Value $cmd -Encoding ASCII

Write-Host ""
Write-Host "Автозапуск установлен." -ForegroundColor Green
Write-Host "Файл:"
Write-Host $cmdPath
Write-Host ""
Write-Host "Сервер будет запускаться при входе этого пользователя в Windows."
Write-Host "Для удаления автозапуска удалите этот .cmd файл."
