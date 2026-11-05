// Release orchestration only. Provider behavior is exercised with synthetic fixtures.
const { spawn, spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const POSTGRES_IMAGE =
  'postgres:17-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73';
const SWITCHES = [
  'WHATSAPP_OWN_NUMBER_CONNECT_ENABLED',
  'WHATSAPP_OWN_NUMBER_SENDING_ENABLED',
  'META_WEBHOOK_DURABLE_ENABLED',
  'NEXT_PUBLIC_OWN_NUMBER_PRICING_ENABLED',
];

function execute(command, args, options = {}) {
  return new Promise((resolve) => {
    // npm.cmd needs cmd.exe on Windows. Arguments here are fixed script names,
    // never merchant data or configuration values.
    const windowsNpm =
      process.platform === 'win32' && ['npm', 'npx'].includes(command);
    const child = spawn(
      windowsNpm ? process.env.ComSpec || 'cmd.exe' : command,
      windowsNpm ? ['/d', '/s', '/c', command, ...args] : args,
      {
        cwd: options.cwd,
        env: options.env,
        windowsHide: true,
        stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      },
    );
    let stdout = '';
    if (options.capture) {
      child.stdout.on('data', (chunk) => (stdout += chunk));
      // Docker diagnostics may include configuration; do not add them to JSON.
      child.stderr.resume();
    }
    child.on('error', () => resolve({ code: 1, stdout }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout }));
  });
}

function snapshot(root, readGit) {
  const git =
    readGit ||
    ((args) => {
      const result = spawnSync('git', ['-C', root, ...args], {
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
      });
      if (result.status !== 0) throw new Error('Cannot fingerprint repository');
      return result.stdout;
    });
  const files = git([
    'ls-files',
    '-z',
    '--cached',
    '--others',
    '--exclude-standard',
  ])
    .split('\0')
    .filter(Boolean)
    .filter(
      (file) =>
        !/(^|\/)\.env(?:\.|$)/i.test(file) &&
        !/^(?:node_modules|dist|\.next|\.tmp)\//.test(file),
    )
    .sort();
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file).update('\0');
    const absolute = path.join(root, file);
    if (!fs.existsSync(absolute)) hash.update('deleted');
    else if (fs.lstatSync(absolute).isSymbolicLink())
      hash.update(fs.readlinkSync(absolute));
    else hash.update(fs.readFileSync(absolute));
    hash.update('\0');
  }
  return {
    commit: git(['rev-parse', 'HEAD']).trim(),
    branch: git(['branch', '--show-current']).trim(),
    dirty: Boolean(git(['status', '--porcelain']).trim()),
    sourceFingerprint: hash.digest('hex'),
  };
}

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const finish = (open) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(500, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function reconcileContract(options = {}) {
  const run = options.execute || execute;
  const env = { ...(options.env || process.env) };
  const cwd = options.backendRoot || path.resolve(__dirname, '..');
  const wait = options.wait || ((ms) => new Promise((r) => setTimeout(r, ms)));
  let container;
  let code = 1;
  const docker = (args) => run('docker', args, { cwd, env, capture: true });
  try {
    const created = await docker([
      'run',
      '--detach',
      '--rm',
      '--label',
      'akeed.e09.reconcile=true',
      '--publish',
      '127.0.0.1::5432',
      '--env',
      'POSTGRES_USER=e045_test',
      '--env',
      'POSTGRES_PASSWORD=e045-synthetic-only',
      '--env',
      'POSTGRES_DB=akeed_e045_test',
      POSTGRES_IMAGE,
    ]);
    container = created.stdout.trim();
    if (created.code || !/^[a-f0-9]{64}$/.test(container))
      throw new Error('Disposable PostgreSQL creation failed');
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      const result = await docker([
        'exec',
        container,
        'pg_isready',
        '-h',
        '127.0.0.1',
        '-U',
        'e045_test',
        '-d',
        'akeed_e045_test',
      ]);
      if (result.code === 0) {
        ready = true;
        break;
      }
      await wait(1000);
    }
    if (!ready) throw new Error('Disposable PostgreSQL did not become ready');
    const binding = await docker(['port', container, '5432/tcp']);
    const match = /^127\.0\.0\.1:(\d+)$/.exec(binding.stdout.trim());
    if (binding.code || !match)
      throw new Error('Unexpected PostgreSQL binding');
    const result = await run(
      'npm',
      ['run', 'test:contract:own-number-pilot-reconcile'],
      {
        cwd,
        env: {
          ...env,
          E045_TEST_DATABASE_URL: `postgresql://e045_test:e045-synthetic-only@127.0.0.1:${match[1]}/akeed_e045_test`,
          E09_TEST_POSTGRES_CONTAINER: container,
        },
      },
    );
    code = result.code;
  } catch {
    console.error('E09 reconciliation contract setup or execution failed.');
  } finally {
    if (/^[a-f0-9]{64}$/.test(container || '')) {
      const removed = await docker(['rm', '--force', container]);
      if (removed.code) code = 1;
    }
  }
  return code;
}

async function runGate(options = {}) {
  const backendRoot = options.backendRoot || path.resolve(__dirname, '..');
  const frontendRoot =
    options.frontendRoot || path.resolve(backendRoot, '../akeed-frontend');
  const observe = options.snapshot || snapshot;
  const run = options.execute || execute;
  const env = { ...(options.env || process.env) };
  for (const name of SWITCHES) delete env[name];
  const report = {
    gate: 'US-09-13',
    status: 'FAILED',
    mode: options.ownOnly ? 'own-only' : 'complete',
    startedAt: new Date().toISOString(),
    backend: observe(backendRoot),
    frontend: observe(frontendRoot),
    steps: [],
  };
  const step = async (name, command, args, cwd = backendRoot) => {
    const started = Date.now();
    console.log(`E09 gate: ${name}`);
    let code = 1;
    try {
      code = (await run(command, args, { cwd, env })).code;
    } catch {
      /* report below */
    }
    report.steps.push({
      name,
      command: [command, ...args].join(' '),
      status: code === 0 ? 'PASS' : 'FAIL',
      exitCode: code,
      startedAt: new Date(started).toISOString(),
      durationMs: Date.now() - started,
    });
  };
  const ps = (name, script) =>
    step(name, 'powershell', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      `scripts/${script}`,
    ]);
  const ports = options.portOpen || portOpen;
  const occupied = [];
  for (const port of [3000, 3001, 3098])
    if (await ports(port)) occupied.push(port);
  if (!options.ownOnly && occupied.length) {
    report.steps.push({
      name: 'server preflight',
      status: 'FAIL',
      exitCode: 1,
      reason: `Active server ports: ${occupied.join(', ')}. Stop servers with owner authorization before the complete gate.`,
    });
  } else {
    await step('orchestrator behavior', 'npm', ['run', 'test:gate:e09:specs']);
    await step('type check', 'npx', ['tsc', '--noEmit', '-p', 'tsconfig.json']);
    await step('structured logs', 'npm', ['run', 'log:check']);
    // The full regression and frontend suite belong to the inherited gate.
    if (options.ownOnly) {
      await step('focused sender, billing, webhook and policy units', 'npm', [
        'test',
        '--',
        '--runInBand',
        '--silent',
        'src/modules/whatsapp-sender',
        'src/shared/billing',
        'src/shared/config',
        'src/infrastructure/spokes/meta',
        'src/modules/verification-core',
        'src/modules/verification-replies',
        'src/modules/verification-automation',
        'src/modules/onboarding',
      ]);
      await step(
        'merchant UI, pricing and locale tests',
        'npx',
        [
          'vitest',
          'run',
          'src/features/whatsapp-connect',
          'src/features/billing',
          'src/features/settings',
          'src/features/dashboard',
          'src/features/marketing',
          'src/features/onboarding',
          'src/features/admin',
          'src/shared/config',
          'src/messages.test.ts',
        ],
        frontendRoot,
      );
      await ps(
        'accounting, recovery, routing and merchant flow contracts',
        'test-e045-contracts.ps1',
      );
    }
    await ps(
      'durable Meta webhook contracts',
      'test-meta-webhook-events-contract.ps1',
    );
    await ps(
      'connection, signup and template setup contracts',
      'test-whatsapp-connections-contract.ps1',
    );
    await ps(
      'sender alert contracts',
      'test-whatsapp-sender-alerts-contract.ps1',
    );
    await step('pilot reconciliation contracts', process.execPath, [
      __filename,
      '--reconcile-contract',
    ]);
    if (options.ownOnly) {
      report.steps.push({
        name: 'inherited E08 and earlier gates',
        status: 'SKIPPED',
        reason: 'Own-only iteration; not a complete release-gate result.',
      });
    } else {
      // E08 -> E07 -> E06 -> E05 includes E04.5 contracts and the merchant flow,
      // plus E04/E03/E02, full units, migration rehearsal, lint and both builds.
      await step('inherited E08 and earlier gates', 'npm', [
        'run',
        'test:gate:e08',
      ]);
    }
  }
  report.backendAfter = observe(backendRoot);
  report.frontendAfter = observe(frontendRoot);
  const unchanged = ['backend', 'frontend'].every(
    (name) =>
      report[name].commit === report[`${name}After`].commit &&
      report[name].sourceFingerprint ===
        report[`${name}After`].sourceFingerprint,
  );
  report.steps.push({
    name: 'source remained unchanged',
    status: unchanged ? 'PASS' : 'FAIL',
    exitCode: unchanged ? 0 : 1,
  });
  const failed = report.steps.some((result) => result.status === 'FAIL');
  report.status = failed ? 'FAILED' : options.ownOnly ? 'PARTIAL_PASS' : 'PASS';
  report.completedAt = new Date().toISOString();
  report.note =
    'Synthetic providers only. Inherited failures may leave descendant checks unrun; their exit code is not evidence those checks passed. No live verification is included.';
  return report;
}

async function main() {
  if (process.argv.includes('--reconcile-contract')) {
    process.exitCode = await reconcileContract();
    return;
  }
  const report = await runGate({
    ownOnly: process.argv.includes('--own-only'),
  });
  const directory =
    process.env.E09_GATE_EVIDENCE_DIR ||
    path.resolve(__dirname, '../.tmp/release-gates');
  fs.mkdirSync(directory, { recursive: true });
  const filename = path.join(
    directory,
    `e09-${report.startedAt.replace(/[:.]/g, '-')}.json`,
  );
  fs.writeFileSync(filename, JSON.stringify(report, null, 2) + '\r\n');
  for (const result of report.steps)
    console.log(`${result.status}  ${result.name}`);
  console.log(`E09 gate: ${report.status}. Report: ${filename}`);
  process.exitCode = report.status === 'FAILED' ? 1 : 0;
}

module.exports = { execute, snapshot, runGate, reconcileContract };
if (require.main === module)
  main().catch(() => {
    console.error('E09 gate could not complete.');
    process.exitCode = 1;
  });
