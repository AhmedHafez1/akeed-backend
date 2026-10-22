const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');

const backend = path.resolve(__dirname, '../..');
const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const separator = arg.indexOf('=');
    return [arg.slice(2, separator), arg.slice(separator + 1)];
  }),
);
if (
  !['backend', 'frontend'].includes(args.target) ||
  (!args.source && !args.ref) ||
  !args.output
) {
  throw new Error(
    'Use --target=backend|frontend --source=absolute-source-path or --ref=git-ref, and --output=absolute-json-path',
  );
}
const repo =
  args.target === 'backend'
    ? backend
    : path.resolve(backend, '../akeed-frontend');
process.chdir(repo);
process.env.NODE_ENV = 'test';

const entry = path.join(
  repo,
  args.target === 'backend'
    ? 'src/modules/verifications/verifications.service.ts'
    : 'src/shared/lib/auth.ts',
);
const source = args.ref
  ? require('node:child_process').execFileSync(
      'git',
      [
        'show',
        `${args.ref}:${path.relative(repo, entry).replaceAll('\\', '/')}`,
      ],
      { cwd: repo, encoding: 'utf8' },
    )
  : fs.readFileSync(path.resolve(args.source), 'utf8');

const loadSource = require('./load-audit-source.cjs').createSourceLoader(
  source,
  entry,
);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const DELAY_MS = 20;
const WARMUPS = 5;
const RUNS = 20;
const percent = (samples, percentile) => {
  const sorted = [...samples].sort((left, right) => left - right);
  return Number(sorted[Math.ceil(sorted.length * percentile) - 1].toFixed(3));
};

async function measure(concurrency, prepare) {
  let calls = 0;
  const samples = [];
  const histogram = monitorEventLoopDelay({ resolution: 1 });
  histogram.enable();
  const startMemory = process.memoryUsage();
  let peakHeap = startMemory.heapUsed;
  let peakRss = startMemory.rss;
  for (let iteration = 0; iteration < WARMUPS + RUNS; iteration += 1) {
    const { run, count } = await prepare();
    if (iteration === WARMUPS) {
      global.gc?.();
      histogram.reset();
    }
    const batch = await Promise.all(
      Array.from({ length: concurrency }, async (_, index) => {
        const started = performance.now();
        await run(index);
        return performance.now() - started;
      }),
    );
    if (iteration >= WARMUPS) {
      samples.push(...batch);
      calls += count();
      const memory = process.memoryUsage();
      peakHeap = Math.max(peakHeap, memory.heapUsed);
      peakRss = Math.max(peakRss, memory.rss);
    }
  }
  histogram.disable();
  return {
    concurrency,
    warmupBatches: WARMUPS,
    measuredBatches: RUNS,
    requests: samples.length,
    p50Ms: percent(samples, 0.5),
    p95Ms: percent(samples, 0.95),
    callsPerRequest: calls / samples.length,
    eventLoopP95Ms: Number((histogram.percentile(95) / 1e6).toFixed(3)),
    startHeapBytes: startMemory.heapUsed,
    peakObservedHeapBytes: peakHeap,
    peakObservedRssBytes: peakRss,
  };
}

async function backendResults() {
  const { VerificationsService } = loadSource();
  const tenants = Array.from({ length: 14 }, (_, tenant) =>
    Array.from({ length: 1_000 }, (_, index) => ({
      id: `verification-${tenant}-${String(index).padStart(4, '0')}`,
      orgId: `org-${tenant}`,
      orderId: `order-${tenant}-${index}`,
      status: 'confirmed',
      createdAt: new Date(Date.now() - index * 1_000).toISOString(),
      order: {
        orgId: `org-${tenant}`,
        customerPhone: `+201${String(index).padStart(9, '0')}`,
        externalOrderId: `external-${tenant}-${index}`,
        isTest: false,
      },
    })),
  );
  const results = [];
  for (const concurrency of [1, 4, 8]) {
    results.push(
      await measure(concurrency, async () => {
        let calls = 0;
        let active = 0;
        const pending = [];
        async function read(value) {
          calls += 1;
          if (active >= 10)
            await new Promise((resolve) => pending.push(resolve));
          else active += 1;
          try {
            await wait(DELAY_MS);
            return value;
          } finally {
            if (pending.length) pending.shift()();
            else active -= 1;
          }
        }
        const repository = {
          findByOrg: (orgId, _statuses, _period, options) =>
            read(tenants[Number(orgId.slice(4))].slice(0, options.limit)),
          countByOrg: () => read(1_000),
          countByTab: () =>
            read({
              all: 1_000,
              confirmed: 1_000,
              canceled: 0,
              failed: 0,
              needs_action: 0,
              no_whatsapp: 0,
            }),
          findHeldByOrg: () => read([]),
          countHeldByOrg: () => read(0),
          getCustomerHistoryByPhones: () => read([]),
        };
        const service = new VerificationsService(
          repository,
          {},
          { findByOrg: () => read([]) },
          {},
          {},
          {},
          { findByCorrelationIds: () => read([]) },
        );
        return {
          run: async (index) => {
            const response = await service.listByOrg(`org-${index % 14}`, {});
            if (response.total_count !== 1_000 || response.data.length !== 20)
              throw new Error('Unexpected list result');
          },
          count: () => calls,
        };
      }),
    );
  }
  return {
    scenario:
      'Actual service, 14 synthetic tenants × 1,000 rows; repository reads mocked at 20ms with 10 slots; no PostgreSQL or network',
    results,
  };
}

async function frontendResults() {
  const storage = new Map();
  let tokenCalls = 0;
  const jwt = `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1_000) + 3_600 })).toString('base64url')}.signature`;
  global.window = {
    location: {
      search: '?shop=synthetic.myshopify.com&host=synthetic',
      pathname: '/en/dashboard',
    },
    sessionStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    },
    shopify: {
      idToken: async () => {
        tokenCalls += 1;
        await wait(DELAY_MS);
        return jwt;
      },
    },
  };
  global.fetch = async () => new Response('{}');
  const results = [];
  for (const concurrency of [1, 4, 8]) {
    results.push(
      await measure(concurrency, async () => {
        const auth = loadSource();
        tokenCalls = 0;
        return {
          run: () => auth.fetchWithAuth('/api/synthetic-local-only'),
          count: () => tokenCalls,
        };
      }),
    );
  }
  return {
    scenario:
      'Actual fetchWithAuth, fresh module per batch; App Bridge mocked at 20ms; fetch mocked; zero external requests',
    results,
  };
}

(async () => {
  const measurement =
    args.target === 'backend'
      ? await backendResults()
      : await frontendResults();
  const output = {
    target: args.target,
    node: process.version,
    platform: `${os.platform()} ${os.arch()}`,
    cpu: os.cpus()[0].model,
    sourceSha256: require('node:crypto')
      .createHash('sha256')
      .update(source)
      .digest('hex'),
    ...measurement,
  };
  const destination = path.resolve(args.output);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
