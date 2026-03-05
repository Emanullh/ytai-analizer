$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$nodeModulesPath = Join-Path $repoRoot 'node_modules'

if (-not (Test-Path $nodeModulesPath)) {
  Write-Host "[test:fix] node_modules not found at $nodeModulesPath"
  Write-Host "[test:fix] Run pnpm install first."
  exit 1
}

Write-Host "[test:fix] Removing read-only flag under node_modules..."
cmd /c "attrib -R `"$nodeModulesPath\*`" /S /D >nul 2>nul" | Out-Null

Write-Host "[test:fix] Resetting ACLs for current user..."
$grantTarget = "${env:USERNAME}:(OI)(CI)RX"
cmd /c "icacls `"$nodeModulesPath`" /grant:r `"$grantTarget`" /T /C >nul 2>nul" | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Host "[test:fix] Permission reset reported errors. Try running this terminal as Administrator."
}

Write-Host "[test:fix] Done. Re-run tests with: pnpm test"
