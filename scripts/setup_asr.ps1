$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $scriptDir '..')
$venvDir = Join-Path $repoRoot '.venv-asr'
$asrRequirementsFile = Join-Path $repoRoot 'apps/api/scripts/requirements-asr.txt'
$autogenRequirementsFile = Join-Path $repoRoot 'apps/api/scripts/requirements-autogen.txt'
$venvPython = Join-Path $venvDir 'Scripts/python.exe'

if (-not (Test-Path $asrRequirementsFile)) {
  throw "[asr:setup] Missing requirements file: $asrRequirementsFile"
}

if (-not (Test-Path $autogenRequirementsFile)) {
  throw "[asr:setup] Missing requirements file: $autogenRequirementsFile"
}

if (-not (Test-Path $venvPython)) {
  if (Get-Command py -ErrorAction SilentlyContinue) {
    Write-Host "[asr:setup] Creating venv at $venvDir"
    & py -3 -m venv $venvDir
  } elseif (Get-Command python -ErrorAction SilentlyContinue) {
    Write-Host "[asr:setup] Creating venv at $venvDir"
    & python -m venv $venvDir
  } else {
    throw '[asr:setup] Python 3 is required but was not found in PATH.'
  }
} else {
  Write-Host "[asr:setup] Reusing existing venv at $venvDir"
}

if (-not (Test-Path $venvPython)) {
  throw "[asr:setup] Missing venv python binary: $venvPython"
}

& $venvPython -m pip install --upgrade pip
& $venvPython -m pip install -r $asrRequirementsFile
& $venvPython -m pip install -r $autogenRequirementsFile

Write-Host "[asr:setup] ASR + AutoGen dependencies installed in $venvDir"
Write-Host "[asr:setup] Python path: $venvPython"
