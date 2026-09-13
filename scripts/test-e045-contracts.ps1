$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$postgresImage = 'postgres:17-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73'
$containerId = $null
$originalE045Url = $env:E045_TEST_DATABASE_URL
$originalE01Url = $env:E01_TEST_DATABASE_URL
$testExitCode = 1
$backendRoot = Split-Path -Parent $PSScriptRoot

function Invoke-ContractStep {
    param(
        [Parameter(Mandatory = $true)] [string] $Name,
        [Parameter(Mandatory = $true)] [string] $Script
    )

    Write-Host "E04.5 PostgreSQL gate: $Name"
    & npm.cmd run $Script
    if ($LASTEXITCODE -ne 0) {
        throw "E04.5 PostgreSQL gate failed at: $Name"
    }
}

Push-Location $backendRoot
try {
    $containerId = (& docker run --detach --rm `
        --label akeed.e045.release-contracts=true `
        --publish '127.0.0.1::5432' `
        --env POSTGRES_USER=e045_test `
        --env POSTGRES_PASSWORD=e045-synthetic-only `
        --env POSTGRES_DB=akeed_e045_test `
        $postgresImage).Trim()
    if ($LASTEXITCODE -ne 0 -or $containerId -notmatch '^[a-f0-9]{64}$') {
        throw 'Could not create the disposable E04.5 PostgreSQL container.'
    }

    $ready = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        & docker exec $containerId pg_isready -U e045_test -d akeed_e045_test *> $null
        if ($LASTEXITCODE -eq 0) {
            $ready = $true
            break
        }
        Start-Sleep -Seconds 1
    }
    if (-not $ready) {
        throw 'Disposable E04.5 PostgreSQL did not become ready.'
    }

    & docker exec $containerId psql -v ON_ERROR_STOP=1 -U e045_test -d postgres `
        -c "CREATE ROLE e01_test LOGIN SUPERUSER PASSWORD 'e01-synthetic-only'" *> $null
    if ($LASTEXITCODE -ne 0) {
        throw 'Could not create the inherited-contract PostgreSQL role.'
    }
    & docker exec $containerId createdb -U e045_test -O e01_test akeed_e01_test *> $null
    if ($LASTEXITCODE -ne 0) {
        throw 'Could not create the inherited-contract PostgreSQL database.'
    }

    $binding = (& docker port $containerId 5432/tcp).Trim()
    if ($binding -notmatch '^127\.0\.0\.1:(\d+)$') {
        throw 'Unexpected disposable PostgreSQL port binding.'
    }
    $port = $Matches[1]
    $env:E045_TEST_DATABASE_URL = "postgresql://e045_test:e045-synthetic-only@127.0.0.1:$port/akeed_e045_test"
    $env:E01_TEST_DATABASE_URL = "postgresql://e01_test:e01-synthetic-only@127.0.0.1:$port/akeed_e01_test"

    Invoke-ContractStep 'US-04.5-01 migration, RLS, immutability and concurrency' 'test:contract:credit-foundation'
    Invoke-ContractStep 'US-04.5-09 signup auto-activation, backfill and one-time grant' 'test:contract:standalone-provisioning'
    Invoke-ContractStep 'US-04.5-03 usage accounting and recovery' 'test:contract:credit-usage'
    Invoke-ContractStep 'US-04.5-04 Paymob checkout, callback and inquiry' 'test:contract:paymob-checkout'
    Invoke-ContractStep 'US-04.5-06 staff operations, debt and repair' 'test:contract:billing-operations'
    Invoke-ContractStep 'US-04.5-07 reconciliation, monitoring and finance metrics' 'test:contract:billing-observability'

    $testExitCode = 0
}
catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
}
finally {
    $env:E045_TEST_DATABASE_URL = $originalE045Url
    $env:E01_TEST_DATABASE_URL = $originalE01Url
    if ($containerId -match '^[a-f0-9]{64}$') {
        & docker rm --force $containerId *> $null
        if ($LASTEXITCODE -ne 0) {
            $testExitCode = 1
            Write-Warning 'Disposable E04.5 PostgreSQL cleanup failed.'
        }
    }
    Pop-Location
}

exit $testExitCode
