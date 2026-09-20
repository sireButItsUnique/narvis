$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)
$Python = Join-Path (Get-Location) ".venv\Scripts\python.exe"
& $Python -m unittest discover -s tests -v
if ($LASTEXITCODE -ne 0) { throw "Python tests failed." }
if (Get-Command node -ErrorAction SilentlyContinue) {
    node --test tests/homography.test.mjs
    if ($LASTEXITCODE -ne 0) { throw "Homography tests failed." }
} else { Write-Host "Node.js not installed; skipped optional homography unit tests." }
