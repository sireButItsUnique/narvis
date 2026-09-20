param([switch]$Demo, [string]$Repo = "", [string]$Model = "", [int]$Port = 8765)
$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)
$Python = Join-Path (Get-Location) ".venv\Scripts\python.exe"
if (-not (Test-Path $Python)) { throw "Run .\scripts\Setup.ps1 first." }
$Arguments = @("-m", "synapsedesk", "serve", "--port", "$Port")
if ($Demo) { $Arguments += "--demo" }
if ($Repo) { $Arguments += @("--repo", $Repo) }
if ($Model) { $Arguments += @("--model", $Model) }
Write-Host "Open http://127.0.0.1:$Port in Edge or Chrome. Ctrl+C stops the service."
& $Python @Arguments
exit $LASTEXITCODE
