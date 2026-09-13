$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Sequential, fail-fast E04.5 release gate. Cheap static checks run first, then
# focused US-04.5 units, the disposable PostgreSQL contracts and finally the
# inherited E04/E03/E02/Shopify gates. The inherited chain already owns the
# full backend regression, backend build, non-fixing lint, structured-log check
# and the frontend typecheck, lint and isolated production build, so they are
# composed rather than duplicated here.

$backendRoot = Split-Path -Parent $PSScriptRoot
$frontendRoot = Join-Path (Split-Path -Parent $backendRoot) 'akeed-frontend'
$evidenceDirectory = if ([string]::IsNullOrWhiteSpace($env:E045_GATE_EVIDENCE_DIR)) {
    Join-Path $backendRoot '.tmp\release-gates'
}
else {
    $env:E045_GATE_EVIDENCE_DIR
}
$startedAt = [DateTimeOffset]::UtcNow
$runId = $startedAt.ToString('yyyyMMddTHHmmssZ')
$reportPath = Join-Path $evidenceDirectory "e045-$runId.json"
$results = [System.Collections.Generic.List[object]]::new()
$gateStatus = 'FAILED'
$failure = $null

# US-04.5 unit suites by story area. US-04.5-05 is frontend-only and is covered
# by locale parity plus the inherited frontend typecheck, lint and build.
$focusedUnitSuites = @(
    # US-04.5-01 credit and payment foundation
    'src/infrastructure/database/credit-domain-contracts.spec.ts',
    'src/shared/billing/',
    'src/shared/config/standalone-credit-billing.config.spec.ts',
    # US-04.5-09 signup auto-activation and one-time grant
    'src/modules/verification-core/credit-eligibility.service.spec.ts',
    'src/modules/admin/standalone-billing.service.spec.ts',
    'src/infrastructure/database/repositories/standalone-organization-provisioning.repository.spec.ts',
    # US-04.5-03 provider-neutral usage accounting
    'src/infrastructure/database/repositories/verification-message-dispatches.repository.spec.ts',
    'src/modules/verification-core/billing-entitlement.service.spec.ts',
    'src/modules/admin/message-dispatch-resolution.service.spec.ts',
    # US-04.5-04 Paymob checkout, HMAC, callbacks and inquiry
    'src/modules/billing/',
    'src/infrastructure/spokes/paymob/',
    'src/shared/guards/payment-callback-rate-limit.guard.spec.ts',
    # US-04.5-06 staff operations
    'src/modules/admin/standalone-billing-operations.policy.spec.ts',
    'src/modules/admin/standalone-billing-operator.guard.spec.ts',
    'src/modules/admin/standalone-billing-logging.interceptor.spec.ts',
    'src/modules/admin/standalone-billing.controller.spec.ts',
    'src/shared/config/standalone-billing-operations.config.spec.ts',
    # US-04.5-07 observability and finance reconciliation
    'src/modules/admin/billing-observability.service.spec.ts',
    'src/modules/admin/billing-reconciliation.producer.spec.ts',
    'src/shared/config/standalone-billing-observability.config.spec.ts'
)

function Get-WorktreeState {
    param([Parameter(Mandatory = $true)] [string] $Root)
    if (-not (Test-Path (Join-Path $Root '.git'))) {
        return $null
    }
    return ((& git -C $Root status --porcelain) -join "`n")
}

function Get-Commit {
    param([Parameter(Mandatory = $true)] [string] $Root)
    if (-not (Test-Path (Join-Path $Root '.git'))) {
        return $null
    }
    return (& git -C $Root rev-parse HEAD).Trim()
}

function Invoke-GateStep {
    param(
        [Parameter(Mandatory = $true)] [string] $Name,
        [Parameter(Mandatory = $true)] [string] $Command,
        [Parameter(Mandatory = $true)] [scriptblock] $Action
    )

    Write-Host "E04.5 release gate: $Name"
    $stepStartedAt = [DateTimeOffset]::UtcNow
    $global:LASTEXITCODE = 0
    try {
        & $Action
        if ($LASTEXITCODE -ne 0) {
            throw "Command exited with code $LASTEXITCODE"
        }
        $results.Add([ordered]@{
            name = $Name
            command = $Command
            status = 'PASS'
            startedAt = $stepStartedAt.ToString('o')
            durationMs = [Math]::Round(([DateTimeOffset]::UtcNow - $stepStartedAt).TotalMilliseconds)
        })
    }
    catch {
        $results.Add([ordered]@{
            name = $Name
            command = $Command
            status = 'FAIL'
            startedAt = $stepStartedAt.ToString('o')
            durationMs = [Math]::Round(([DateTimeOffset]::UtcNow - $stepStartedAt).TotalMilliseconds)
            error = $_.Exception.Message
        })
        throw "E04.5 release gate failed at '$Name': $($_.Exception.Message)"
    }
}

$backendStateBefore = Get-WorktreeState $backendRoot
$frontendStateBefore = Get-WorktreeState $frontendRoot

Push-Location $backendRoot
try {
    Invoke-GateStep 'documentation, status and safe-evidence contract' `
        'node scripts/check-e045-release-docs.js' {
        & node scripts/check-e045-release-docs.js
    }
    Invoke-GateStep 'Arabic/English billing locale parity' `
        'node scripts/check-e045-locale-parity.js' {
        & node scripts/check-e045-locale-parity.js
    }
    Invoke-GateStep 'focused US-04.5 unit suites' `
        'npm test -- --runInBand <US-04.5 unit suites>' {
        # A renamed spec would otherwise drop out of the run silently.
        foreach ($suite in $focusedUnitSuites) {
            if (-not (Test-Path $suite)) {
                throw "Focused unit suite path is missing: $suite"
            }
        }
        & npm.cmd test -- --runInBand @focusedUnitSuites
    }
    Invoke-GateStep 'focused US-04.5 disposable PostgreSQL contracts' `
        'npm run test:contract:e045' {
        & npm.cmd run test:contract:e045
    }
    Invoke-GateStep 'E04 acceptance and inherited E03/E02/Shopify release gates' `
        'powershell scripts/test-e045-inherited-gates.ps1' {
        & powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-e045-inherited-gates.ps1
    }
    Invoke-GateStep 'gate left tracked worktrees unchanged' `
        'git status --porcelain (backend and frontend, before and after)' {
        if ((Get-WorktreeState $backendRoot) -ne $backendStateBefore) {
            throw 'The gate changed the backend worktree.'
        }
        if ((Get-WorktreeState $frontendRoot) -ne $frontendStateBefore) {
            throw 'The gate changed the frontend worktree.'
        }
    }
    $gateStatus = 'PASS'
}
catch {
    $failure = $_.Exception.Message
    Write-Host $failure -ForegroundColor Red
}
finally {
    Pop-Location
    New-Item -ItemType Directory -Force -Path $evidenceDirectory *> $null
    [ordered]@{
        gate = 'US-04.5-08'
        runId = $runId
        status = $gateStatus
        startedAt = $startedAt.ToString('o')
        completedAt = [DateTimeOffset]::UtcNow.ToString('o')
        backendCommit = Get-Commit $backendRoot
        backendDirtyWorktree = -not [string]::IsNullOrEmpty($backendStateBefore)
        frontendCommit = Get-Commit $frontendRoot
        frontendDirtyWorktree = -not [string]::IsNullOrEmpty($frontendStateBefore)
        steps = $results
        failure = $failure
        note = 'This report contains step names and outcomes only; provider credentials and process output are not recorded.'
    } | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 $reportPath
    Write-Host "E04.5 release gate report: $reportPath"
}

if ($gateStatus -ne 'PASS') {
    exit 1
}
