const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  runGate,
  snapshot,
  reconcileContract,
} = require('./e09-release-gate.cjs');

function gateOptions(overrides = {}) {
  return {
    backendRoot: 'backend',
    frontendRoot: 'frontend',
    snapshot: () => ({ commit: 'fixture', sourceFingerprint: 'unchanged' }),
    execute: () => Promise.resolve({ code: 0 }),
    portOpen: () => Promise.resolve(false),
    env: {},
    ...overrides,
  };
}

test('complete gate inherits E08; accounting contracts are inherited once', async () => {
  const report = await runGate(gateOptions());
  assert.equal(report.status, 'PASS');
  assert(report.steps.some((s) => s.command?.includes('test:gate:e08')));
  assert(!report.steps.some((s) => s.command?.includes('test-e045-contracts')));
});

test('own-only runs accounting contracts and cannot claim a complete PASS', async () => {
  const report = await runGate(gateOptions({ ownOnly: true }));
  assert.equal(report.status, 'PARTIAL_PASS');
  assert(report.steps.some((s) => s.command?.includes('test-e045-contracts')));
  assert(report.steps.some((s) => s.status === 'SKIPPED'));
});

test('failure and thrown commands remain failures while later checks run', async () => {
  let call = 0;
  const report = await runGate(
    gateOptions({
      execute: async () => {
        if (++call === 1) throw new Error('synthetic');
        return { code: call === 2 ? 7 : 0 };
      },
    }),
  );
  assert.equal(report.status, 'FAILED');
  assert.equal(report.steps.filter((s) => s.status === 'FAIL').length, 2);
  assert(report.steps.some((s) => s.command?.includes('test:gate:e08')));
});

test('active servers prevent build-containing gates', async () => {
  let calls = 0;
  const report = await runGate(
    gateOptions({
      portOpen: async (port) => port === 3001,
      execute: async () => {
        calls++;
        return { code: 0 };
      },
    }),
  );
  assert.equal(calls, 0);
  assert.equal(report.status, 'FAILED');
});

test('configuration is isolated to children and source mutation fails the gate', async () => {
  const env = { WHATSAPP_OWN_NUMBER_SENDING_ENABLED: 'true', SENTINEL: 'kept' };
  let snapshots = 0;
  const report = await runGate(
    gateOptions({
      env,
      snapshot: () => ({
        commit: 'same',
        sourceFingerprint: ++snapshots > 2 ? 'changed' : 'before',
      }),
      execute: async (_command, _args, options) => {
        assert.equal(
          options.env.WHATSAPP_OWN_NUMBER_SENDING_ENABLED,
          undefined,
        );
        assert.equal(options.env.SENTINEL, 'kept');
        return { code: 0 };
      },
    }),
  );
  assert.equal(env.WHATSAPP_OWN_NUMBER_SENDING_ENABLED, 'true');
  assert.equal(report.status, 'FAILED');
});

test('fingerprints include dirty and untracked content, deletion, and exclude secrets', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'akeed-e09-snapshot-'));
  try {
    fs.writeFileSync(path.join(root, 'source.ts'), 'one');
    fs.writeFileSync(path.join(root, 'untracked.ts'), 'new');
    fs.writeFileSync(path.join(root, '.env'), 'do not fingerprint');
    const git = (args) =>
      args[0] === 'ls-files' ? 'source.ts\0untracked.ts\0.env\0' : 'fixture';
    const first = snapshot(root, git).sourceFingerprint;
    fs.writeFileSync(path.join(root, '.env'), 'changed secret');
    assert.equal(snapshot(root, git).sourceFingerprint, first);
    fs.writeFileSync(path.join(root, 'untracked.ts'), 'changed');
    const second = snapshot(root, git).sourceFingerprint;
    assert.notEqual(second, first);
    fs.unlinkSync(path.join(root, 'source.ts'));
    assert.notEqual(snapshot(root, git).sourceFingerprint, second);
  } finally {
    assert.equal(path.dirname(root), os.tmpdir());
    assert.match(path.basename(root), /^akeed-e09-snapshot-/);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const failure of ['test', 'readiness', 'binding', 'cleanup']) {
  test(`disposable contract cleans up and fails on ${failure}`, async () => {
    const calls = [];
    const env = { E045_TEST_DATABASE_URL: 'unchanged-original' };
    const code = await reconcileContract({
      env,
      wait: async () => {},
      execute: async (command, args, options) => {
        calls.push(args);
        if (command === 'npm') {
          assert.match(
            options.env.E045_TEST_DATABASE_URL,
            /127\.0\.0\.1:54321/,
          );
          assert.equal(options.env.E09_TEST_POSTGRES_CONTAINER, 'a'.repeat(64));
          return { code: failure === 'test' ? 9 : 0 };
        }
        if (args[0] === 'run') return { code: 0, stdout: 'a'.repeat(64) };
        if (args[0] === 'exec')
          return { code: failure === 'readiness' ? 1 : 0, stdout: '' };
        if (args[0] === 'port')
          return {
            code: 0,
            stdout: failure === 'binding' ? '0.0.0.0:54321' : '127.0.0.1:54321',
          };
        return { code: failure === 'cleanup' ? 1 : 0, stdout: '' };
      },
    });
    assert.notEqual(code, 0);
    assert(
      calls.some((args) => args[0] === 'rm' && args[2] === 'a'.repeat(64)),
    );
    assert.equal(env.E045_TEST_DATABASE_URL, 'unchanged-original');
  });
}
