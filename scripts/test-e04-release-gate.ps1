$ErrorActionPreference = 'Stop'

function Invoke-GateStep {
    param(
        [Parameter(Mandatory = $true)] [string] $Name,
        [Parameter(Mandatory = $true)] [scriptblock] $Command
    )
    Write-Host "E04 gate: $Name"
    & $Command
    if ($LASTEXITCODE -ne 0) {
        throw "E04 release gate failed at: $Name"
    }
}

$backendRoot = Split-Path -Parent $PSScriptRoot

Push-Location $backendRoot
try {
    Invoke-GateStep 'composed Standalone manual MVP acceptance' {
        npm.cmd run test:acceptance:e04
    }
    Invoke-GateStep 'manual-order PostgreSQL contract' {
        npm.cmd run test:contract:manual-orders
    }
    Invoke-GateStep 'inherited E03 and E02 release gates' {
        npm.cmd run test:gate:e03
    }
}
finally {
    Pop-Location
}
