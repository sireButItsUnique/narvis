param([switch]$Demo, [string]$Repo = "", [string]$Model = "", [int]$Port = 8770,
      [string]$ModelEndpoint = "", [string]$ModelName = "", [string]$Runtime = "")
$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)
$Python = Join-Path (Get-Location) ".venv\Scripts\python.exe"
if (-not (Test-Path $Python)) { throw "Run .\scripts\Setup.ps1 first." }
$Arguments = @("-m", "synapsedesk", "serve", "--port", "$Port")
if ($Demo) { $Arguments += "--demo" }
if ($Repo) { $Arguments += @("--repo", $Repo) }
if ($Model) { $Arguments += @("--model", $Model) }
if ($ModelEndpoint) { $Arguments += @("--model-endpoint", $ModelEndpoint) }
if ($ModelName) { $Arguments += @("--model-name", $ModelName) }
if ($Runtime) { $Arguments += @("--runtime", $Runtime) }
if ($ModelEndpoint -and -not $env:SYNAPSEDESK_API_KEY) {
  Write-Warning "SYNAPSEDESK_API_KEY is not set; the live agent gate stays blocked."
}
Write-Host "Open http://127.0.0.1:$Port in Edge or Chrome. Ctrl+C stops the service."
& $Python @Arguments
exit $LASTEXITCODE
