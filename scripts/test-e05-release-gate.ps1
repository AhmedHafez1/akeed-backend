$ErrorActionPreference = 'Stop'

# US-05-06 release gate: the order API's own suites, every regression suite of
# the E05 shared rules (each PostgreSQL contract on its own disposable
# container), the inherited E04/E03/E02/Shopify gates and the frontend checks.
# Every step runs even after a failure, so one run reports the whole picture.
# The summary lines and the JSON report are what the story evidence records.

$postgresImage = 'postgres:17-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73'
$backendRoot = Split-Path -Parent $PSScriptRoot
$frontendRoot = Join-Path (Split-Path -Parent $backendRoot) 'akeed-frontend'
$evidenceDirectory = if ([string]::IsNullOrWhiteSpace($env:E05_GATE_EVIDENCE_DIR)) {
    Join-Path $backendRoot '.tmp\release-gates'
}
else {
    $env:E05_GATE_EVIDENCE_DIR
}
$startedAt = [DateTimeOffset]::UtcNow
$reportPath = Join-Path $evidenceDirectory "e05-$($startedAt.ToString('yyyyMMddTHHmmssZ')).json"
$results = New-Object System.Collections.Generic.List[object]
$failed = $false

function Add-Result {
    param([string] $Name, [string] $Command, [int] $ExitCode, [DateTimeOffset] $StepStartedAt)
    $results.Add([ordered]@{
        name = $Name
        command = $Command
        status = if ($ExitCode -eq 0) { 'PASS' } else { 'FAIL' }
        exitCode = $ExitCode
        durationMs = [Math]::Round(([DateTimeOffset]::UtcNow - $StepStartedAt).TotalMilliseconds)
    })
    if ($ExitCode -ne 0) { $script:failed = $true }
}

function Invoke-Step {
    param([string] $Name, [string] $Command, [scriptblock] $Run)
    Write-Host "E05 gate: $Name"
    $stepStartedAt = [DateTimeOffset]::UtcNow
    $exitCode = 1
    try {
        & $Run
        $exitCode = $LASTEXITCODE
    }
    catch {
        Write-Host $_.Exception.Message -ForegroundColor Red
    }
    Add-Result $Name $Command $exitCode $stepStartedAt
}

function Invoke-E01Contract {
    param([string] $Name, [string] $NpmScript)
    Write-Host "E05 gate: $Name"
    $stepStartedAt = [DateTimeOffset]::UtcNow
    $containerId = $null
    $original = $env:E01_TEST_DATABASE_URL
    $exitCode = 1
    try {
        $containerId = (& docker run --detach --rm --label akeed.e05.release-gate=true --publish '127.0.0.1::5432' --env POSTGRES_USER=e01_test --env POSTGRES_PASSWORD=e01-synthetic-only --env POSTGRES_DB=akeed_e01_test $postgresImage).Trim()
        if ($LASTEXITCODE -ne 0 -or $containerId -notmatch '^[a-f0-9]{64}$') { throw 'Could not create disposable PostgreSQL container.' }
        $ready = $false
        for ($attempt = 0; $attempt -lt 30; $attempt++) {
            & docker exec $containerId pg_isready -h 127.0.0.1 -U e01_test -d akeed_e01_test *> $null
            if ($LASTEXITCODE -eq 0) { $ready = $true; break }
            Start-Sleep -Seconds 1
        }
        if (-not $ready) { throw 'Disposable PostgreSQL did not become ready.' }
        # Over TCP: the image's init server listens on the socket only, so a
        # socket check can pass before the real server has started.
        Start-Sleep -Seconds 2
        $binding = (& docker port $containerId 5432/tcp).Trim()
        if ($binding -notmatch '^127\.0\.0\.1:(\d+)$') { throw 'Unexpected test database port binding.' }
        $env:E01_TEST_DATABASE_URL = "postgresql://e01_test:e01-synthetic-only@127.0.0.1:$($Matches[1])/akeed_e01_test"
        & npm.cmd run $NpmScript
        $exitCode = $LASTEXITCODE
    }
    catch {
        Write-Host $_.Exception.Message -ForegroundColor Red
    }
    finally {
        $env:E01_TEST_DATABASE_URL = $original
        if ($containerId -match '^[a-f0-9]{64}$') {
            & docker rm --force $containerId *> $null
        }
    }
    Add-Result $Name "npm run $NpmScript" $exitCode $stepStartedAt
}

function Get-Commit {
    param([string] $Root)
    Push-Location $Root
    try { return (& git rev-parse --short HEAD).Trim() }
    catch { return $null }
    finally { Pop-Location }
}

function Get-WorktreeState {
    param([string] $Root)
    Push-Location $Root
    try { return ((& git status --porcelain) -join "`n") }
    catch { return $null }
    finally { Pop-Location }
}

$backendStateBefore = Get-WorktreeState $backendRoot
$frontendStateBefore = Get-WorktreeState $frontendRoot

Push-Location $backendRoot
try {
    Invoke-Step 'type check' 'npx tsc --noEmit -p tsconfig.json' { npx.cmd tsc --noEmit -p tsconfig.json }
    Invoke-Step 'structured-log contract' 'npm run log:check' { npm.cmd run log:check }
    Invoke-Step 'server API guide matches the tested examples' 'npm run docs:order-api-guide:check' { npm.cmd run docs:order-api-guide:check }
    # US-05-06 AC2: reuse-map, ingestion-boundary and release-gate-architecture.
    Invoke-Step 'ingestion core and architecture guards' 'npx jest src/modules/order-ingestion' { npx.cmd jest src/modules/order-ingestion --silent }
    Invoke-Step 'manual, file-import, API and key channels' 'npx jest src/modules/orders src/modules/order-imports src/modules/order-api src/modules/integration-keys' {
        npx.cmd jest src/modules/orders src/modules/order-imports src/modules/order-api src/modules/integration-keys --silent
    }
    Invoke-Step 'platform-neutral core' 'npm run test:core:platform-neutral' { npm.cmd run test:core:platform-neutral -- --silent }

    # US-05-06 AC1, AC3, AC4, AC5 and AC6.
    Invoke-E01Contract 'E05 release-gate contract (equivalence, isolation, revocation, recovery, end to end)' 'test:contract:order-api-release-gate'
    # US-05-02, US-05-03 and every documented example of US-05-05.
    Invoke-E01Contract 'order API contracts (endpoint, idempotency, guide examples)' 'test:contract:order-api'
    Invoke-E01Contract 'integration API keys contract' 'test:contract:integration-keys'

    # AC7: the regression suites of the E05 shared rules.
    Invoke-E01Contract 'manual-order contract' 'test:contract:manual-orders'
    Invoke-E01Contract 'order-imports contract' 'test:contract:order-imports'
    Invoke-E01Contract 'order-import release-gate contract' 'test:contract:order-import-release-gate'
    Invoke-E01Contract 'entitlement contract' 'test:contract:entitlements'
    Invoke-E01Contract 'shopify contract' 'test:contract:shopify'
    Invoke-Step 'E04.5 credit and billing contracts' 'powershell scripts/test-e045-contracts.ps1' {
        powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/test-e045-contracts.ps1
    }
    # The E04 manual journey, then E03 and E02: the full backend regression,
    # the Shopify, migration and source-identity contracts, the backend build
    # and lint, and the frontend typecheck, dual-mode fixture typecheck, lint
    # and isolated production build.
    Invoke-Step 'E04 acceptance and inherited E03/E02/Shopify gates' 'powershell scripts/test-e045-inherited-gates.ps1' {
        powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/test-e045-inherited-gates.ps1
    }
}
finally {
    Pop-Location
}

if (Test-Path (Join-Path $frontendRoot 'package.json')) {
    Push-Location $frontendRoot
    try {
        Invoke-Step 'frontend unit suite (API keys tab, localized errors, server API guide)' 'npm run test' { npm.cmd run test }
        Invoke-Step 'frontend reuse map' 'npm run check:reuse-map' { npm.cmd run check:reuse-map }
    }
    finally {
        Pop-Location
    }
}
else {
    $results.Add([ordered]@{ name = 'frontend checks'; command = ''; status = 'MISSING'; exitCode = 1; durationMs = 0 })
    $failed = $true
}

New-Item -ItemType Directory -Force -Path $evidenceDirectory *> $null
[ordered]@{
    gate = 'US-05-06'
    status = if ($failed) { 'FAILED' } else { 'PASS' }
    startedAt = $startedAt.ToString('o')
    completedAt = [DateTimeOffset]::UtcNow.ToString('o')
    backendCommit = Get-Commit $backendRoot
    backendDirtyWorktree = -not [string]::IsNullOrEmpty($backendStateBefore)
    backendWorktreeChangedByGate = (Get-WorktreeState $backendRoot) -ne $backendStateBefore
    frontendCommit = Get-Commit $frontendRoot
    frontendDirtyWorktree = -not [string]::IsNullOrEmpty($frontendStateBefore)
    frontendWorktreeChangedByGate = (Get-WorktreeState $frontendRoot) -ne $frontendStateBefore
    steps = $results
    note = 'Step names and outcomes only; process output is not recorded. The pilot is not part of this gate.'
} | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 $reportPath

Write-Host ''
Write-Host 'E05 release gate summary'
$results | ForEach-Object { Write-Host "$($_.status)  $($_.name) (exit $($_.exitCode))" }
Write-Host "E05 release gate report: $reportPath"
if ($failed) { exit 1 }
exit 0
