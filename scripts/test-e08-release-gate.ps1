param([switch] $OwnOnly)

$ErrorActionPreference = 'Stop'

# US-08-08 release gate: the WhatsApp template suites (criteria 1 to 6), each
# PostgreSQL contract on its own disposable container, then the inherited E07
# gate, which carries E06, E05, E04, E03, E02 and E01/Shopify, the full
# backend regression, both builds and the frontend checks (criterion 7).
# Every step runs even after a failure, so one run reports the whole picture.
# The summary lines and the JSON report are what the story evidence records.
# No step calls Meta: both Meta edges are in-process fakes built from the
# US-08-01 contract record. The live run is not part of this gate.
#
# `-OwnOnly` (npm run test:gate:e08 -- -OwnOnly) skips the inherited gate and
# says so in the report. It is for iterating; it is not a gate result.
#
# Stop the dev servers first: the inherited E02 gate runs `nest build`, which
# deletes `dist`, and a frontend production build.

$postgresImage = 'postgres:17-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73'
$backendRoot = Split-Path -Parent $PSScriptRoot
$frontendRoot = Join-Path (Split-Path -Parent $backendRoot) 'akeed-frontend'
$evidenceDirectory = if ([string]::IsNullOrWhiteSpace($env:E08_GATE_EVIDENCE_DIR)) {
    Join-Path $backendRoot '.tmp\release-gates'
}
else {
    $env:E08_GATE_EVIDENCE_DIR
}
$startedAt = [DateTimeOffset]::UtcNow
$reportPath = Join-Path $evidenceDirectory "e08-$($startedAt.ToString('yyyyMMddTHHmmssZ')).json"
$results = New-Object System.Collections.Generic.List[object]
$failed = $false

# Criterion 3 runs with every US-08-07 switch off, and no suite may inherit a
# template switch from the shell that started the gate.
$templateSwitches = @(
    'WHATSAPP_TEMPLATE_SYNC_ENABLED',
    'WHATSAPP_TEMPLATE_GUARDRAIL_ENABLED',
    'WHATSAPP_TEMPLATE_OPERATIONS_ENABLED',
    'WHATSAPP_TEMPLATE_OPERATOR_IDS',
    'WHATSAPP_TEMPLATE_TEST_PHONES',
    'WHATSAPP_REMINDER_TEMPLATE_ENABLED',
    'WHATSAPP_ACKNOWLEDGMENT_ENABLED',
    'WHATSAPP_UNRESOLVED_REPLY_NUDGE_ENABLED',
    'WHATSAPP_ARABIC_STYLE_AUTO_ENABLED',
    'WHATSAPP_LOCALIZED_FALLBACKS_ENABLED',
    'WHATSAPP_AMOUNT_FORMATTING_ENABLED',
    'WHATSAPP_SNAPSHOT_PREVIEW_ENABLED'
)
$originalSwitches = @{}
foreach ($name in $templateSwitches) {
    $originalSwitches[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
    [Environment]::SetEnvironmentVariable($name, $null, 'Process')
}

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
    Write-Host "E08 gate: $Name"
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

# One disposable PostgreSQL for one contract suite. `-WithCreditDatabase`
# also creates the E04.5 database and role beside the E01 ones, for a suite
# that runs the real usage accounting.
function Invoke-Contract {
    param([string] $Name, [string] $NpmScript, [switch] $WithCreditDatabase)
    Write-Host "E08 gate: $Name"
    $stepStartedAt = [DateTimeOffset]::UtcNow
    $containerId = $null
    $originalE01 = $env:E01_TEST_DATABASE_URL
    $originalE045 = $env:E045_TEST_DATABASE_URL
    $exitCode = 1
    try {
        $containerId = (& docker run --detach --rm --label akeed.e08.release-gate=true --publish '127.0.0.1::5432' --env POSTGRES_USER=e01_test --env POSTGRES_PASSWORD=e01-synthetic-only --env POSTGRES_DB=akeed_e01_test $postgresImage).Trim()
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
        $port = $Matches[1]
        $env:E01_TEST_DATABASE_URL = "postgresql://e01_test:e01-synthetic-only@127.0.0.1:$port/akeed_e01_test"
        if ($WithCreditDatabase) {
            & docker exec $containerId psql -v ON_ERROR_STOP=1 -h 127.0.0.1 -U e01_test -d postgres -c "CREATE ROLE e045_test LOGIN SUPERUSER PASSWORD 'e045-synthetic-only'" *> $null
            if ($LASTEXITCODE -ne 0) { throw 'Could not create the credit-contract PostgreSQL role.' }
            & docker exec $containerId createdb -h 127.0.0.1 -U e01_test -O e045_test akeed_e045_test *> $null
            if ($LASTEXITCODE -ne 0) { throw 'Could not create the credit-contract PostgreSQL database.' }
            $env:E045_TEST_DATABASE_URL = "postgresql://e045_test:e045-synthetic-only@127.0.0.1:$port/akeed_e045_test"
        }
        & npm.cmd run $NpmScript
        $exitCode = $LASTEXITCODE
    }
    catch {
        Write-Host $_.Exception.Message -ForegroundColor Red
    }
    finally {
        $env:E01_TEST_DATABASE_URL = $originalE01
        $env:E045_TEST_DATABASE_URL = $originalE045
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

    # Criteria 1, 2, 4, 5 and 6 in process: the fakes against the contract
    # record, the webhook replay and ordering matrix over HTTP, the guardrail
    # matrix, every admin template route by role, and the fixture secret scan.
    Invoke-Step 'E08 gate specs (Meta contract, webhook matrix, guardrail matrix, role and operator controls, secret scan)' 'npm run test:gate:e08:specs' {
        npm.cmd run test:gate:e08:specs -- --silent
    }

    # Criterion 3: the recorded Meta payload for all 8 variants on the first
    # send, the reminder and the test, and the Settings template block, with
    # every US-08-07 switch off; and nothing at runtime reads the code catalog.
    Invoke-Step 'no-behavior-change characterization, every US-08-07 switch off' 'npx jest whatsapp-send-payload.characterization settings-template-block.characterization no-runtime-catalog-import' {
        npx.cmd jest src/infrastructure/spokes/meta/whatsapp-send-payload.characterization.spec.ts src/modules/onboarding/settings-template-block.characterization.spec.ts src/shared/messaging/no-runtime-catalog-import.spec.ts --silent
    }

    # Criteria 2, 4 and 5 in the per-story suites: the port adapter, the
    # webhook handler and the send payloads; sync, events and alerts; the
    # selector, the draft rules and the lifecycle policy; free-form texts.
    Invoke-Step 'Meta spoke: template adapter, webhook handler and sends' 'npx jest src/infrastructure/spokes/meta' {
        npx.cmd jest src/infrastructure/spokes/meta --silent
    }
    Invoke-Step 'registry, sync, status events, selector, drafts, lifecycle and free-form texts' 'npx jest src/modules/template-registry src/shared/messaging src/modules/message-texts src/modules/verification-replies src/shared/config' {
        npx.cmd jest src/modules/template-registry src/shared/messaging src/modules/message-texts src/modules/verification-replies src/shared/config --silent
    }
    # Criterion 6: the staff and operator guards, the audit rows and what
    # each admin service keeps out of them.
    Invoke-Step 'admin template routes, operator guard, audit and test send' 'npx jest src/modules/admin' {
        npx.cmd jest src/modules/admin --silent
    }
    Invoke-Step 'platform-neutral core: send path, guardrail and recorded skips' 'npm run test:core:platform-neutral' { npm.cmd run test:core:platform-neutral -- --silent }
    Invoke-Step 'reminder and reply jobs, settings and the merchant test send' 'npx jest src/modules/verification-automation src/modules/onboarding src/modules/verifications' {
        npx.cmd jest src/modules/verification-automation src/modules/onboarding src/modules/verifications --silent
    }

    # Criterion 5 end to end, and the migrations of every E08 story.
    Invoke-Contract 'E08 release-gate contract (guardrail end to end: never sent, reason recorded, no usage on a skip)' 'test:contract:whatsapp-template-release-gate' -WithCreditDatabase
    Invoke-Contract 'template identity per send contract (US-08-02)' 'test:contract:template-identity'
    Invoke-Contract 'template registry contract (US-08-03)' 'test:contract:whatsapp-template-registry'
    Invoke-Contract 'template sync and status webhook contract (US-08-04)' 'test:contract:whatsapp-template-sync'
    Invoke-Contract 'template authoring contract: drafts, submit, edit, lifecycle and audit (US-08-06)' 'test:contract:whatsapp-template-authoring'
    Invoke-Contract 'message improvements contract: reminder, free-form texts and no usage (US-08-07)' 'test:contract:whatsapp-message-improvements' -WithCreditDatabase
}
finally {
    Pop-Location
}

# The staff template pages, the Settings Message tab in both skins and the
# neutral preview (US-08-05, US-08-06, US-08-07g).
Push-Location $frontendRoot
try {
    Invoke-Step 'frontend: admin template pages, Settings message tab and previews' 'npx vitest run src/features/admin src/features/settings src/features/onboarding src/shared/lib/templateMessage.test.ts' {
        npx.cmd vitest run src/features/admin src/features/settings src/features/onboarding src/shared/lib/templateMessage.test.ts
    }
}
finally {
    Pop-Location
}

if (-not $OwnOnly) {
    Push-Location $backendRoot
    try {
        # Criterion 7: E07, which runs E06, E05, the E04 acceptance and the
        # E03, E02 and E01/Shopify gates: the full backend regression, build
        # and lint, and the frontend typecheck, lint, unit suite and build.
        Invoke-Step 'inherited E07 gate (WooCommerce, E06, E05, E04, E03, E02, E01/Shopify, frontend)' 'npm run test:gate:e07' { npm.cmd run test:gate:e07 }
    }
    finally {
        Pop-Location
    }
}

foreach ($name in $templateSwitches) {
    [Environment]::SetEnvironmentVariable($name, $originalSwitches[$name], 'Process')
}

New-Item -ItemType Directory -Force -Path $evidenceDirectory *> $null
[ordered]@{
    gate = 'US-08-08'
    status = if ($failed) { 'FAILED' } elseif ($OwnOnly) { 'PASS (own steps only; inherited gate not run)' } else { 'PASS' }
    inheritedGate = if ($OwnOnly) { 'not run' } else { 'run' }
    startedAt = $startedAt.ToString('o')
    completedAt = [DateTimeOffset]::UtcNow.ToString('o')
    backendCommit = Get-Commit $backendRoot
    backendDirtyWorktree = -not [string]::IsNullOrEmpty($backendStateBefore)
    backendWorktreeChangedByGate = (Get-WorktreeState $backendRoot) -ne $backendStateBefore
    frontendCommit = Get-Commit $frontendRoot
    frontendDirtyWorktree = -not [string]::IsNullOrEmpty($frontendStateBefore)
    frontendWorktreeChangedByGate = (Get-WorktreeState $frontendRoot) -ne $frontendStateBefore
    steps = $results
    note = 'Step names and outcomes only; process output is not recorded. Meta is an in-process fake in every step. The live run is not part of this gate.'
} | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 $reportPath

Write-Host ''
Write-Host 'E08 release gate summary'
$results | ForEach-Object { Write-Host "$($_.status)  $($_.name) (exit $($_.exitCode))" }
Write-Host "E08 release gate report: $reportPath"
if ($failed) { exit 1 }
exit 0
