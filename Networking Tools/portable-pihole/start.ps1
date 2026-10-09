# Run from an Administrator PowerShell terminal. Package installs may need a reboot.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$python = Get-Command python -ErrorAction SilentlyContinue
$launcher = Get-Command py -ErrorAction SilentlyContinue
$ready = $false
if ($launcher) {
    & py -3 -c 'import sys; sys.exit(sys.version_info < (3,10))'
    $ready = $LASTEXITCODE -eq 0
} elseif ($python) {
    & python -c 'import sys; sys.exit(sys.version_info < (3,10))'
    $ready = $LASTEXITCODE -eq 0
}
if (-not $ready) {
    & winget install --exact --id Python.Python.3.12 --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) { throw 'Python installation failed.' }
    Write-Host 'Python installed. Open a fresh Administrator terminal and rerun start.ps1.'
    exit 0
}
if ($launcher) { & py -3 deploy.py @args } else { & python deploy.py @args }
exit $LASTEXITCODE
