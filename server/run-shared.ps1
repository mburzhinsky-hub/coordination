$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$supervisor = Join-Path $PSScriptRoot "supervisor.ps1"
if (-not (Test-Path $supervisor)) {
  Write-Host "server\supervisor.ps1 was not found." -ForegroundColor Red
  exit 1
}

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $supervisor
