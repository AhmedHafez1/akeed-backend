$ErrorActionPreference = 'Stop'

# US-04.6-10 release gate: every unit, acceptance and PostgreSQL contract
# suite, each contract suite on its own disposable container. The summary
# lines are what the story evidence records.

$postgresImage = 'postgres:17-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73'
$backendRoot = Split-Path -Parent $PSScriptRoot
$results = New-Object System.Collections.Generic.List[string]
$failed = $false

function Add-Result {
    param([string] $Name, [int] $ExitCode)
    $verdict = if ($ExitCode -eq 0) { 'PASS' } else { 'FAIL' }
    $results.Add("$verdict  $Name (exit $ExitCode)")
    if ($ExitCode -ne 0) { $script:failed = $true }
}

function Invoke-Step {
    param([string] $Name, [scriptblock] $Command)
    Write-Host "E04.6 gate: $Name"
    & $Command
    Add-Result $Name $LASTEXITCODE
}

function Invoke-WithDisposablePostgres {
    param(
        [string] $Name,
        [string] $EnvVar,
        [string] $User,
        [string] $Password,
        [string] $Database,
        [string] $NpmScript
    )
    Write-Host "E04.6 gate: $Name"
    $scripts = (Get-Content package.json -Raw | ConvertFrom-Json).scripts
    if (-not ($scripts.PSObject.Properties.Name -contains $NpmScript)) {
        $results.Add("MISSING  $Name (no npm script $NpmScript)")
        $script:failed = $true
        return
    }
    $containerId = $null
    $original = [Environment]::GetEnvironmentVariable($EnvVar)
    $exitCode = 1
    try {
        $containerId = (& docker run --detach --rm --label akeed.e046.release-gate=true --publish '127.0.0.1::5432' --env "POSTGRES_USER=$User" --env "POSTGRES_PASSWORD=$Password" --env "POSTGRES_DB=$Database" $postgresImage).Trim()
        if ($LASTEXITCODE -ne 0 -or $containerId -notmatch '^[a-f0-9]{64}$') { throw 'Could not create disposable PostgreSQL container.' }
        $ready = $false
        for ($attempt = 0; $attempt -lt 30; $attempt++) {
            & docker exec $containerId pg_isready -h 127.0.0.1 -U $User -d $Database *> $null
            if ($LASTEXITCODE -eq 0) { $ready = $true; break }
            Start-Sleep -Seconds 1
        }
        if (-not $ready) { throw 'Disposable PostgreSQL did not become ready.' }
        # Over TCP: the image's init server listens on the socket only, so a
        # socket check can pass before the real server has started.
        Start-Sleep -Seconds 2
        $binding = (& docker port $containerId 5432/tcp).Trim()
        if ($binding -notmatch '^127\.0\.0\.1:(\d+)$') { throw 'Unexpected test database port binding.' }
        [Environment]::SetEnvironmentVariable($EnvVar, "postgresql://${User}:${Password}@127.0.0.1:$($Matches[1])/$Database")
        & npm.cmd run $NpmScript
        $exitCode = $LASTEXITCODE
    }
    catch {
        Write-Host $_.Exception.Message -ForegroundColor Red
    }
    finally {
        [Environment]::SetEnvironmentVariable($EnvVar, $original)
        if ($containerId -match '^[a-f0-9]{64}$') {
            & docker rm --force $containerId *> $null
        }
    }
    Add-Result $Name $exitCode
}

function Invoke-E01Contract {
    param([string] $Name, [string] $NpmScript)
    Invoke-WithDisposablePostgres $Name 'E01_TEST_DATABASE_URL' 'e01_test' 'e01-synthetic-only' 'akeed_e01_test' $NpmScript
}

Push-Location $backendRoot
try {
    Invoke-Step 'type check' { npx.cmd tsc --noEmit -p tsconfig.json }
    Invoke-Step 'unit suite (npm test)' { npm.cmd test -- --silent }
    Invoke-Step 'E04 composed acceptance' { npm.cmd run test:acceptance:e04 }
    Invoke-Step 'platform-neutral core' { npm.cmd run test:core:platform-neutral -- --silent }
    Invoke-E01Contract 'manual-order contract' 'test:contract:manual-orders'
    Invoke-E01Contract 'order-imports contract' 'test:contract:order-imports'
    Invoke-E01Contract 'order-import release-gate contract' 'test:contract:order-import-release-gate'
    Invoke-E01Contract 'entitlement contract' 'test:contract:entitlements'
    Invoke-E01Contract 'shopify contract' 'test:contract:shopify'
    Invoke-E01Contract 'source-identity contract' 'test:contract:source-identity'
    Invoke-WithDisposablePostgres 'platform-boundary migration contract' 'E02_GATE_TEST_DATABASE_URL' 'e02_gate_test' 'e02-synthetic-only' 'akeed_e02_gate_test' 'test:contract:platform-boundary-migration'
    Invoke-Step 'E04.5 billing contracts (credit-foundation, standalone-provisioning, credit-usage, paymob-checkout, billing-operations, billing-observability)' {
        powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/test-e045-contracts.ps1
    }
}
finally {
    Pop-Location
}

Write-Host ''
Write-Host 'E04.6 release gate summary'
$results | ForEach-Object { Write-Host $_ }
if ($failed) { exit 1 }
exit 0
