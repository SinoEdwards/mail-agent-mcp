# Build Mail Agent MCP from the current checkout. This script never clones,
# pulls, changes an MCP client configuration, or handles credentials.
$ErrorActionPreference = 'Stop'
$required = [version]'22.12.0'
try { $current = [version]((node --version).TrimStart('v')) } catch {
  throw 'Node.js 22.12 or newer is required.'
}
if ($current -lt $required) {
  throw "Node.js 22.12 or newer is required; found $current."
}
if (-not (Test-Path -LiteralPath 'package-lock.json')) {
  throw 'Run install.ps1 from the repository root.'
}
npm ci
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
npm run build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host 'Build complete. Next: node dist/enroll.js --help'
Write-Host 'Enroll locally, then add dist/index.js to your MCP client.'
