param([int]$Camera = 0, [ValidateSet("dshow","msmf","auto")][string]$Backend = "dshow", [switch]$Mirror, [int]$Port = 8770)
$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)
$Python = Join-Path (Get-Location) ".venv\Scripts\python.exe"
if (-not (Test-Path $Python)) { throw "Run .\scripts\Setup.ps1 -Tracking first." }
$Arguments = @("-m", "synapsedesk", "track", "--camera", "$Camera", "--backend", $Backend, "--port", "$Port")
if ($Mirror) { $Arguments += "--mirror" }
& $Python @Arguments
exit $LASTEXITCODE
