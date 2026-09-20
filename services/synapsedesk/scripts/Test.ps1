$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)
$Python = Join-Path (Get-Location) ".venv\Scripts\python.exe"
& $Python -m unittest discover -s tests -v
if ($LASTEXITCODE -ne 0) { throw "Python tests failed." }
if (Get-Command node -ErrorAction SilentlyContinue) {
    node --test (Get-ChildItem tests\*.test.mjs | ForEach-Object { $_.FullName })
    if ($LASTEXITCODE -ne 0) { throw "Geometry tests failed." }
} else { Write-Host "Node.js not installed; skipped optional homography and rig geometry tests." }
