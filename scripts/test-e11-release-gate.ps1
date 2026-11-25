$ErrorActionPreference = 'Stop'

# Release gate for E11 shipping notifications (US-11-04). It runs the type
# checks, the targeted lint, the structured-log and platform-neutral checks,
# the E11 unit specs and replay fixtures, both shipping contracts on their own
# disposable PostgreSQL, and the frontend E11 tests and locale checks.
# Steps run one at a time and every step runs even after a failure, so one run
# reports the whole picture. The JSON report records step names and outcomes,
# not process output.
#
# No step builds: nothing writes to `dist` or `.next`, and no server is
# started. The gate still refuses to run while 3000, 3001 or 3098 answer, so a
# dev server is never raced. Shopify and Meta are fakes in every step; no
# message is sent. The live checks are not part of this gate.

$postgresImage = 'postgres:17-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73'
$backendRoot = Split-Path -Parent $PSScriptRoot
$frontendRoot = Join-Path (Split-Path -Parent $backendRoot) 'akeed-frontend'
$workspaceRoot = Split-Path -Parent $backendRoot
$evidenceDirectory = if ([string]::IsNullOrWhiteSpace($env:E11_GATE_EVIDENCE_DIR)) {
    Join-Path $backendRoot '.tmp\release-gates'
}
else {
    $env:E11_GATE_EVIDENCE_DIR
}
$startedAt = [DateTimeOffset]::UtcNow
$reportPath = Join-Path $evidenceDirectory "e11-$($startedAt.ToString('yyyyMMddTHHmmssZ')).json"
$results = New-Object System.Collections.Generic.List[object]
$failed = $false

# The suites set the switch themselves; none may inherit it from the shell.
$switches = @('SHIPPING_NOTIFICATIONS_ENABLED')
$originalSwitches = @{}
foreach ($name in $switches) {
    $originalSwitches[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
    [Environment]::SetEnvironmentVariable($name, $null, 'Process')
}

# The E11 backend code, specs, contracts and fixtures, for the targeted lint.
$backendLintFiles = @(
    'src/app.module.ts',
    'src/infrastructure/database/database.module.ts',
    'src/infrastructure/database/repositories/periodic-plan-accounting.ts',
    'src/infrastructure/database/repositories/shipping-notifications.repository.ts',
    'src/infrastructure/database/repositories/store-data-deletion.repository.ts',
    'src/infrastructure/database/repositories/verification-message-dispatches.repository.ts',
    'src/infrastructure/database/repositories/verification-needs-action.sql.ts',
    'src/infrastructure/database/repositories/verification-service-messages.repository.ts',
    'src/infrastructure/database/schema.ts',
    'src/infrastructure/spokes/meta/own-number/meta-send-context.service.ts',
    'src/infrastructure/spokes/meta/whatsapp.service.shipping.spec.ts',
    'src/infrastructure/spokes/meta/whatsapp.service.ts',
    'src/infrastructure/spokes/meta/whatsapp.webhook.service.ts',
    'src/infrastructure/spokes/meta/whatsapp.webhook.shipping.spec.ts',
    'src/infrastructure/spokes/shopify/dto/shopify-webhooks.dto.ts',
    'src/infrastructure/spokes/shopify/services/shopify-auth.service.ts',
    'src/infrastructure/spokes/shopify/services/shopify-order-updated-webhook.spec.ts',
    'src/infrastructure/spokes/shopify/services/shopify-order-webhook.service.ts',
    'src/infrastructure/spokes/shopify/services/shopify-orders-updated.replay.spec.ts',
    'src/infrastructure/spokes/shopify/services/shopify-shipping-event.mapper.spec.ts',
    'src/infrastructure/spokes/shopify/services/shopify-shipping-event.mapper.ts',
    'src/infrastructure/spokes/shopify/services/shopify-shipping-event.source.ts',
    'src/infrastructure/spokes/shopify/shopify-commerce.module.ts',
    'src/infrastructure/spokes/shopify/shopify.controller.ts',
    'src/modules/admin/admin-message-texts.service.ts',
    'src/modules/admin/admin-template-draft.service.spec.ts',
    'src/modules/onboarding/dto/onboarding.dto.ts',
    'src/modules/onboarding/onboarding-settings.shipping-preview.spec.ts',
    'src/modules/onboarding/onboarding-state.service.ts',
    'src/modules/onboarding/onboarding-state.shipping.spec.ts',
    'src/modules/onboarding/onboarding.service.ts',
    'src/modules/orders/dto/dashboard.dto.ts',
    'src/modules/shipping-notifications',
    'src/modules/verification-automation/verification-automation.constants.ts',
    'src/modules/verification-automation/verification-automation.processor.ts',
    'src/modules/verification-automation/verification-automation.producer.ts',
    'src/modules/verification-automation/verification-automation.shipping.spec.ts',
    'src/modules/verification-core/verification-send.service.ts',
    'src/modules/verification-replies/customer-reply-follow-up.service.ts',
    'src/modules/verifications/shipping-needs-action.controller.ts',
    'src/modules/verifications/verifications.module.ts',
    'src/modules/verifications/verifications.service.ts',
    'src/modules/verifications/verifications.shipping-settings.spec.ts',
    'src/modules/webhook-queue/webhook-queue.module.ts',
    'src/modules/webhook-queue/webhook-queue.producer.admit.spec.ts',
    'src/modules/webhook-queue/webhook-queue.producer.ts',
    'src/shared/billing/shipping-charge.policy.spec.ts',
    'src/shared/billing/shipping-charge.policy.ts',
    'src/shared/config/env-validation.ts',
    'src/shared/config/shipping-notifications.config.ts',
    'src/shared/messaging/change-request-messaging.ts',
    'src/shared/messaging/cod-template-selector.ts',
    'src/shared/messaging/message-languages.spec.ts',
    'src/shared/messaging/message-texts.types.ts',
    'src/shared/messaging/template-draft.types.ts',
    'src/shared/messaging/template-draft.validation.spec.ts',
    'src/shared/messaging/template-draft.validation.ts',
    'src/shared/messaging/template-provider.types.ts',
    'src/shared/messaging/template-registry.types.ts',
    'src/shared/messaging/template-rendering.spec.ts',
    'src/shared/messaging/template-rendering.ts',
    'src/shared/ports/messaging.port.ts',
    'src/shared/shipping',
    'src/shared/verification/verification-needs-action.ts',
    'test/shipping-billing.contract-spec.ts',
    'test/shipping-notifications.contract-spec.ts',
    'test/fixtures/shipping-notifications'
)

# The E11 unit specs, and the existing specs E11 changed.
$backendUnitSpecs = @(
    'src/modules/shipping-notifications',
    'src/shared/shipping',
    'src/shared/billing/shipping-charge.policy.spec.ts',
    'src/infrastructure/spokes/shopify/services/shopify-order-updated-webhook.spec.ts',
    'src/infrastructure/spokes/shopify/services/shopify-orders-updated.replay.spec.ts',
    'src/infrastructure/spokes/shopify/services/shopify-shipping-event.mapper.spec.ts',
    'src/infrastructure/spokes/meta/whatsapp.service.shipping.spec.ts',
    'src/infrastructure/spokes/meta/whatsapp.webhook.shipping.spec.ts',
    'src/infrastructure/spokes/meta/whatsapp-send-payload.characterization.spec.ts',
    'src/modules/onboarding/onboarding-settings.shipping-preview.spec.ts',
    'src/modules/onboarding/onboarding-state.shipping.spec.ts',
    'src/modules/verification-automation/verification-automation.shipping.spec.ts',
    'src/modules/verifications/verifications.shipping-settings.spec.ts',
    'src/modules/webhook-queue/webhook-queue.producer.admit.spec.ts',
    'src/modules/admin/admin-template-draft.service.spec.ts',
    'src/shared/messaging/message-languages.spec.ts',
    'src/shared/messaging/template-draft.validation.spec.ts',
    'src/shared/messaging/template-rendering.spec.ts'
)

$frontendTests = @(
    'src/features/dashboard/domain/needsActionRow.test.ts',
    'src/features/dashboard/domain/noWhatsApp.test.ts',
    'src/features/dashboard/domain/shippingStatus.test.ts',
    'src/features/dashboard/skins/shippingUi.test.tsx',
    'src/features/settings/domain/shippingSettings.test.ts',
    'src/features/settings/skins/embedded/settings-page/SettingsEmbeddedPage.shipping.test.tsx',
    'src/messages.test.ts',
    'src/features/docs'
)
$guideLocales = @('ar', 'ur', 'es', 'fr', 'tr')
$checkDocs = Join-Path $workspaceRoot '.claude\skills\localization\scripts\check-docs.js'

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
    Write-Host "E11 gate: $Name"
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
# also creates the E04.5 database and role, for a suite that runs the real
# usage accounting.
function Invoke-Contract {
    param([string] $Name, [string] $NpmScript, [switch] $WithCreditDatabase)
    Write-Host "E11 gate: $Name"
    $stepStartedAt = [DateTimeOffset]::UtcNow
    $containerId = $null
    $originalE01 = $env:E01_TEST_DATABASE_URL
    $originalE045 = $env:E045_TEST_DATABASE_URL
    $exitCode = 1
    try {
        $containerId = (& docker run --detach --rm --label akeed.e11.release-gate=true --publish '127.0.0.1::5432' --env POSTGRES_USER=e01_test --env POSTGRES_PASSWORD=e01-synthetic-only --env POSTGRES_DB=akeed_e01_test $postgresImage).Trim()
        if ($LASTEXITCODE -ne 0 -or $containerId -notmatch '^[a-f0-9]{64}$') { throw 'Could not create disposable PostgreSQL container.' }
        $ready = $false
        for ($attempt = 0; $attempt -lt 30; $attempt++) {
            & docker exec $containerId pg_isready -h 127.0.0.1 -U e01_test -d akeed_e01_test *> $null
            if ($LASTEXITCODE -eq 0) { $ready = $true; break }
            Start-Sleep -Seconds 1
        }
        if (-not $ready) { throw 'Disposable PostgreSQL did not become ready.' }
        # The image's init server listens on the socket only, so a socket
        # check can pass before the real server has started.
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
            if ($LASTEXITCODE -ne 0) { $exitCode = 1; Write-Host 'Disposable container cleanup failed.' -ForegroundColor Red }
        }
    }
    Add-Result $Name "npm run $NpmScript" $exitCode $stepStartedAt
}

function Test-PortOpen {
    param([int] $Port)
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $connect = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        if (-not $connect.AsyncWaitHandle.WaitOne(500)) { return $false }
        $client.EndConnect($connect)
        return $true
    }
    catch { return $false }
    finally { $client.Close() }
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
# Read before the first step: a commit that lands while the gate runs must
# not be reported as the commit that was tested.
$backendCommitBefore = Get-Commit $backendRoot
$frontendCommitBefore = Get-Commit $frontendRoot

$occupied = @(3000, 3001, 3098 | Where-Object { Test-PortOpen $_ })
if ($occupied.Count -gt 0) {
    $results.Add([ordered]@{
        name = 'server preflight'
        status = 'FAIL'
        exitCode = 1
        reason = "Active server ports: $($occupied -join ', '). Ask the owner before running the gate beside their servers."
    })
    $failed = $true
}
else {
    Push-Location $backendRoot
    try {
        Invoke-Step 'backend type check' 'npx tsc --noEmit -p tsconfig.json' { npx.cmd tsc --noEmit -p tsconfig.json }
        Invoke-Step 'backend lint on the E11 files' 'npx eslint <E11 files>' { npx.cmd eslint @backendLintFiles }
        Invoke-Step 'structured-log contract' 'npm run log:check' { npm.cmd run log:check }
        Invoke-Step 'platform-neutral core (shipping core included)' 'npm run test:core:platform-neutral' { npm.cmd run test:core:platform-neutral -- --silent }
        Invoke-Step 'E11 unit specs and orders/updated intake replay' 'npx jest --runInBand <E11 specs>' {
            npx.cmd jest --runInBand --silent @backendUnitSpecs
        }
        Invoke-Contract 'shipping notifications contract: record, replay fixtures, replies, tenant isolation (E01)' 'test:contract:shipping-notifications'
        Invoke-Contract 'shipping billing contract: pool boundary, refusals, fallback, refunds, one dispatch per order (E04.5)' 'test:contract:shipping-billing' -WithCreditDatabase
    }
    finally {
        Pop-Location
    }

    Push-Location $frontendRoot
    try {
        Invoke-Step 'frontend type check' 'npx tsc --noEmit' { npx.cmd tsc --noEmit }
        Invoke-Step 'frontend lint' 'npm run lint' { npm.cmd run lint }
        Invoke-Step 'frontend E11 tests, messages and guides' 'npx vitest run <E11 tests>' { npx.cmd vitest run @frontendTests }
        foreach ($locale in $guideLocales) {
            Invoke-Step "help guides match English: $locale" "node check-docs.js $locale" { & node $checkDocs $locale }
        }
    }
    finally {
        Pop-Location
    }
}

foreach ($name in $switches) {
    [Environment]::SetEnvironmentVariable($name, $originalSwitches[$name], 'Process')
}

New-Item -ItemType Directory -Force -Path $evidenceDirectory *> $null
[ordered]@{
    gate = 'US-11-04'
    status = if ($failed) { 'FAILED' } else { 'PASS' }
    startedAt = $startedAt.ToString('o')
    completedAt = [DateTimeOffset]::UtcNow.ToString('o')
    backendCommit = $backendCommitBefore
    backendCommitChangedDuringGate = (Get-Commit $backendRoot) -ne $backendCommitBefore
    backendDirtyWorktree = -not [string]::IsNullOrEmpty($backendStateBefore)
    backendWorktreeChangedByGate = (Get-WorktreeState $backendRoot) -ne $backendStateBefore
    frontendCommit = $frontendCommitBefore
    frontendCommitChangedDuringGate = (Get-Commit $frontendRoot) -ne $frontendCommitBefore
    frontendDirtyWorktree = -not [string]::IsNullOrEmpty($frontendStateBefore)
    frontendWorktreeChangedByGate = (Get-WorktreeState $frontendRoot) -ne $frontendStateBefore
    steps = $results
    note = 'Step names and outcomes only; process output is not recorded. Shopify and Meta are fakes in every step and no message is sent. No build runs. Known pre-existing failures outside this gate: sender-recovery (one Starter-pool case), EasyOrders and WooCommerce connection contracts. The live checks are not part of this gate.'
} | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 $reportPath

Write-Host ''
Write-Host 'E11 release gate summary'
$results | ForEach-Object { Write-Host "$($_.status)  $($_.name) (exit $($_.exitCode))" }
Write-Host "E11 release gate report: $reportPath"
if ($failed) { exit 1 }
exit 0
