$ErrorActionPreference = 'Stop'

# US-07-06 release gate: the WooCommerce spoke's own suites (each PostgreSQL
# contract on its own disposable container), the suites of the shared rules it
# touches, then the inherited E06 gate, which carries the EasyOrders suites
# and the E05 gate, and through it the E04, E03, E02 and E01/Shopify gates,
# the full backend regression, both builds and the frontend checks.
# Every step runs even after a failure, so one run reports the whole picture.
# The summary lines and the JSON report are what the story evidence records.
# The live pilot is not part of this gate and calls no store.
#
# Stop the dev servers first: the inherited E02 gate runs `nest build`, which
# deletes `dist`, and a frontend production build.

$postgresImage = 'postgres:17-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73'
$backendRoot = Split-Path -Parent $PSScriptRoot
$frontendRoot = Join-Path (Split-Path -Parent $backendRoot) 'akeed-frontend'
$evidenceDirectory = if ([string]::IsNullOrWhiteSpace($env:E07_GATE_EVIDENCE_DIR)) {
    Join-Path $backendRoot '.tmp\release-gates'
}
else {
    $env:E07_GATE_EVIDENCE_DIR
}
$startedAt = [DateTimeOffset]::UtcNow
$reportPath = Join-Path $evidenceDirectory "e07-$($startedAt.ToString('yyyyMMddTHHmmssZ')).json"
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
    Write-Host "E07 gate: $Name"
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
    Write-Host "E07 gate: $Name"
    $stepStartedAt = [DateTimeOffset]::UtcNow
    $containerId = $null
    $original = $env:E01_TEST_DATABASE_URL
    $exitCode = 1
    try {
        $containerId = (& docker run --detach --rm --label akeed.e07.release-gate=true --publish '127.0.0.1::5432' --env POSTGRES_USER=e01_test --env POSTGRES_PASSWORD=e01-synthetic-only --env POSTGRES_DB=akeed_e01_test $postgresImage).Trim()
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
    # US-07-06 AC2: the shared adapter contract and the WooCommerce
    # authentication, mapping, COD and status fixtures, against the fake.
    Invoke-Step 'WooCommerce spoke: shared adapter contract, fixtures and unit specs' 'npx jest src/infrastructure/spokes/woocommerce' {
        npx.cmd jest src/infrastructure/spokes/woocommerce --silent
    }
    Invoke-Step 'restricted outbound client, logging and the exception filter' 'npx jest src/shared/http src/shared/logging src/shared/filters src/shared/config' {
        npx.cmd jest src/shared/http src/shared/logging src/shared/filters src/shared/config --silent
    }
    Invoke-Step 'platform-neutral core and outcome retry' 'npm run test:core:platform-neutral' { npm.cmd run test:core:platform-neutral -- --silent }
    Invoke-Step 'onboarding, settings and source health' 'npx jest src/modules/onboarding src/modules/verifications' {
        npx.cmd jest src/modules/onboarding src/modules/verifications --silent
    }

    # US-07-06 AC1 to AC3 against the fake: the shared conformance matrix and
    # the cases only WooCommerce has.
    Invoke-E01Contract 'E07 release-gate contract (conformance matrix, HMAC and source, draft then placed, webhook re-enable, SSRF)' 'test:contract:woocommerce-release-gate'
    Invoke-E01Contract 'WooCommerce connection contract' 'test:contract:woocommerce-connection'
    Invoke-E01Contract 'WooCommerce ingestion contract' 'test:contract:woocommerce-ingestion'
    Invoke-E01Contract 'WooCommerce outcome-sync contract' 'test:contract:woocommerce-outcome-sync'

    # AC6: E06, which runs the EasyOrders suites on the same conformance
    # harness, the shared-rule contracts, and the E05 gate: the E04
    # acceptance and the E03, E02 and E01/Shopify gates, the full backend
    # regression, build and lint, and the frontend typecheck, lint, unit suite
    # and isolated production build.
    Invoke-Step 'inherited E06 gate (EasyOrders, E05, E04, E03, E02, E01/Shopify, frontend)' 'npm run test:gate:e06' { npm.cmd run test:gate:e06 }
}
finally {
    Pop-Location
}

New-Item -ItemType Directory -Force -Path $evidenceDirectory *> $null
[ordered]@{
    gate = 'US-07-06'
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
    note = 'Step names and outcomes only; process output is not recorded. The live pilot is not part of this gate.'
} | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 $reportPath

Write-Host ''
Write-Host 'E07 release gate summary'
$results | ForEach-Object { Write-Host "$($_.status)  $($_.name) (exit $($_.exitCode))" }
Write-Host "E07 release gate report: $reportPath"
if ($failed) { exit 1 }
exit 0
