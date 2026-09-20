param([switch]$Tracking, [switch]$Rust, [switch]$Polyglot)
$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)
py -3.12 -m venv .venv
if ($LASTEXITCODE -ne 0) { throw "Install 64-bit Python 3.12 for Windows, including the py launcher." }
$Python = Join-Path (Get-Location) ".venv\Scripts\python.exe"
$Extras = @()
if ($Tracking) { $Extras += "tracking" }
if ($Polyglot) { $Extras += "polyglot" }
elseif ($Rust) { $Extras += "rust" }
if ($Extras.Count -gt 0) { $Spec = ".[" + ($Extras -join ",") + "]" } else { $Spec = "." }
& $Python -m pip install -e $Spec
if ($LASTEXITCODE -ne 0) { throw "Dependency installation failed." }
Write-Host "Ready. Run .\scripts\Start-SynapseDesk.ps1 -Demo"
