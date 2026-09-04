$ErrorActionPreference = 'Stop'

function Invoke-GateStep {
    param(
        [Parameter(Mandatory = $true)] [string] $Name,
        [Parameter(Mandatory = $true)] [scriptblock] $Command
    )
    Write-Host "E02 gate: $Name"
    & $Command
    if ($LASTEXITCODE -ne 0) {
        throw "E02 release gate failed at: $Name"
    }
}

$backendRoot = Split-Path -Parent $PSScriptRoot
$frontendRoot = Join-Path (Split-Path -Parent $backendRoot) 'akeed-frontend'

Push-Location $backendRoot
try {
    Invoke-GateStep 'core without Shopify services' { npm.cmd run test:core:platform-neutral }
    Invoke-GateStep 'reusable adapter contract and Shopify-specific expectations' { npm.cmd test -- --runInBand src/infrastructure/spokes/shopify/services/shopify-outcome.adapter.spec.ts }
    Invoke-GateStep 'full backend regression' { npm.cmd test -- --runInBand }
    Invoke-GateStep 'platform migration rehearsal' { & .\scripts\test-platform-boundary-migration-contract.ps1 }
    Invoke-GateStep 'Shopify PostgreSQL characterization and queue recovery' { & .\scripts\test-shopify-contract.ps1 }
    Invoke-GateStep 'source identity and disconnect retention' { & .\scripts\test-source-identity-contract.ps1 }
    Invoke-GateStep 'backend build' { npm.cmd run build }
    Invoke-GateStep 'backend non-fixing lint' { npx.cmd eslint "{src,apps,libs,test}/**/*.ts" }
}
finally {
    Pop-Location
}

Push-Location $frontendRoot
try {
    Invoke-GateStep 'frontend route type generation' { npx.cmd next typegen }
    Invoke-GateStep 'frontend application typecheck' { npx.cmd tsc --noEmit }
    Invoke-GateStep 'frontend dual-mode fixture typecheck' { npm.cmd run smoke:e02:typecheck }
    Invoke-GateStep 'frontend non-fixing lint' { npm.cmd run lint }
    $originalFrontendDist = $env:NEXT_DIST_DIR
    try {
        $env:NEXT_DIST_DIR = '.next/e01-validation-build'
        Invoke-GateStep 'frontend isolated production build' { npm.cmd run build }
    }
    finally {
        $env:NEXT_DIST_DIR = $originalFrontendDist
    }
}
finally {
    Pop-Location
}
