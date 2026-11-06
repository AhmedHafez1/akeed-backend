param([switch] $OwnOnly)

$ErrorActionPreference = 'Stop'
$arguments = @((Join-Path $PSScriptRoot 'e09-release-gate.cjs'))
if ($OwnOnly) { $arguments += '--own-only' }
& node @arguments
exit $LASTEXITCODE
