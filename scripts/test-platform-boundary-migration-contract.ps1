$ErrorActionPreference = 'Stop'
$containerId = $null
$originalTestUrl = $env:E02_GATE_TEST_DATABASE_URL
$testExitCode = 1
Push-Location (Split-Path -Parent $PSScriptRoot)
try {
    $containerId = (& docker run --detach --rm --label akeed.e02.platform-boundary-gate=true --publish '127.0.0.1::5432' --env POSTGRES_USER=e02_gate_test --env POSTGRES_PASSWORD=e02-synthetic-only --env POSTGRES_DB=akeed_e02_gate_test 'postgres:17-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73').Trim()
    if ($LASTEXITCODE -ne 0 -or $containerId -notmatch '^[a-f0-9]{64}$') { throw 'Could not create disposable PostgreSQL container.' }
    $ready = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        & docker exec $containerId pg_isready -U e02_gate_test -d akeed_e02_gate_test *> $null
        if ($LASTEXITCODE -eq 0) { $ready = $true; break }
        Start-Sleep -Seconds 1
    }
    if (-not $ready) { throw 'Disposable PostgreSQL did not become ready.' }
    $binding = (& docker port $containerId 5432/tcp).Trim()
    if ($binding -notmatch '^127\.0\.0\.1:(\d+)$') { throw 'Unexpected test database port binding.' }
    $env:E02_GATE_TEST_DATABASE_URL = "postgresql://e02_gate_test:e02-synthetic-only@127.0.0.1:$($Matches[1])/akeed_e02_gate_test"
    & npm.cmd run test:contract:platform-boundary-migration
    $testExitCode = $LASTEXITCODE
}
finally {
    $env:E02_GATE_TEST_DATABASE_URL = $originalTestUrl
    if ($containerId -match '^[a-f0-9]{64}$') {
        & docker rm --force $containerId
        if ($LASTEXITCODE -ne 0) { $testExitCode = 1; Write-Warning 'Disposable container cleanup failed.' }
    }
    Pop-Location
}
exit $testExitCode
