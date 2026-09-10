$ErrorActionPreference = 'Stop'

function Invoke-GateStep {
    param(
        [Parameter(Mandatory = $true)] [string] $Name,
        [Parameter(Mandatory = $true)] [scriptblock] $Command
    )
    Write-Host "E03 gate: $Name"
    & $Command
    if ($LASTEXITCODE -ne 0) {
        throw "E03 release gate failed at: $Name"
    }
}

$backendRoot = Split-Path -Parent $PSScriptRoot

Push-Location $backendRoot
try {
    Invoke-GateStep 'E02 compatibility gate' { npm.cmd run test:gate:e02 }
    Invoke-GateStep 'backend structured-log contract' { npm.cmd run log:check }
    Invoke-GateStep 'tenant and role guards' {
        npm.cmd test -- --runInBand `
            src/modules/auth/services/token-validator.service.spec.ts `
            src/modules/organizations/organizations.service.spec.ts `
            src/modules/onboarding/provider-neutral-settings.spec.ts `
            src/modules/verifications/test-verification.service.spec.ts `
            src/modules/verifications/verifications.controller.spec.ts `
            src/modules/verifications/verifications.service.spec.ts
    }
    Invoke-GateStep 'Standalone provisioning and primary-source concurrency' {
        & .\scripts\test-standalone-provisioning-contract.ps1
    }
    Invoke-GateStep 'Standalone credit approval eligibility and audit' {
        & .\scripts\test-standalone-pilot-contract.ps1
    }
}
finally {
    Pop-Location
}
