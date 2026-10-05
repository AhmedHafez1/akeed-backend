import type {
  TemplateEventOutcome,
  TemplateSyncRun,
  TemplateSyncTrigger,
} from '../../../infrastructure/database/repositories/whatsapp-template-sync.repository';
import type {
  ProviderState,
  SyncedTemplateRow,
  TemplateProviderEvent,
} from '../../../shared/messaging/template-provider.types';
import { seededRegistryTemplates } from '../../../shared/messaging/testing/seeded-template-registry';

const EVENT_AT = {
  status: 'statusEventAt',
  quality: 'qualityEventAt',
  category: 'categoryEventAt',
} as const;

/** The seeded registry as sync sees it, before any sync. */
export function seededSyncRows(): SyncedTemplateRow[] {
  return seededRegistryTemplates().map((template, index) => ({
    id: `row-${index + 1}`,
    key: template.key,
    purpose: template.purpose,
    isActive: template.isActive,
    isDefault: template.isDefault,
    templateName: template.templateName,
    languageCode: template.languageCode,
    providerTemplateId: null,
    reviewStatus: null,
    category: null,
    pendingCategory: null,
    quality: null,
    components: null,
    statusEventAt: null,
    qualityEventAt: null,
    categoryEventAt: null,
  }));
}

/**
 * An in-memory `WhatsappTemplateSyncRepository` for specs. It keeps the
 * repository's contract (one running run, event identity dedupe, sync raising
 * the event times, an atomic sync write) without a database. The SQL itself
 * is covered by the contract suite.
 */
export class InMemoryTemplateSyncRepository {
  rows: SyncedTemplateRow[];
  runs: TemplateSyncRun[] = [];
  events: {
    identityKey: string;
    outcome: TemplateEventOutcome;
    templateId: string | null;
  }[] = [];
  driftAt = new Map<string, string>();
  lastSyncedAt = new Map<string, string>();
  storeCounts = new Map<string, number>();
  failNextCompleteSync = false;
  private sequence = 0;

  constructor(rows: SyncedTemplateRow[] = seededSyncRows()) {
    this.rows = rows;
  }

  row(key: string): SyncedTemplateRow {
    const found = this.rows.find((row) => row.key === key);
    if (!found) throw new Error(`no row ${key}`);
    return found;
  }

  startRun(
    trigger: TemplateSyncTrigger,
    requestedBy: string | null,
    now: Date = new Date(),
  ): Promise<TemplateSyncRun | null> {
    if (this.runs.some((run) => run.status === 'running')) {
      return Promise.resolve(null);
    }
    this.sequence += 1;
    const run: TemplateSyncRun = {
      id: `run-${this.sequence}`,
      trigger,
      requestedBy,
      status: 'running',
      startedAt: new Date(now.getTime() + this.sequence).toISOString(),
      finishedAt: null,
      providerTemplateCount: null,
      updatedCount: null,
      unchangedCount: null,
      missingKeys: null,
      unknownAtProvider: null,
      errorCode: null,
    };
    this.runs.push(run);
    return Promise.resolve(run);
  }

  failRun(id: string, errorCode: string): Promise<TemplateSyncRun> {
    const run = this.runs.find((candidate) => candidate.id === id)!;
    Object.assign(run, {
      status: 'failed',
      errorCode,
      finishedAt: new Date().toISOString(),
    });
    return Promise.resolve(run);
  }

  recentRuns(limit: number): Promise<TemplateSyncRun[]> {
    return Promise.resolve([...this.runs].reverse().slice(0, limit));
  }

  lastFinishedRun(): Promise<TemplateSyncRun | null> {
    const finished = this.runs.filter((run) => run.status !== 'running');
    return Promise.resolve(finished.at(-1) ?? null);
  }

  listRows(): Promise<SyncedTemplateRow[]> {
    return Promise.resolve(this.rows.map((row) => ({ ...row })));
  }

  completeSync(params: {
    run: TemplateSyncRun;
    rows: { id: string; next: ProviderState; drift: boolean }[];
    providerTemplateCount: number;
    updatedCount: number;
    missingKeys: string[];
    unknownAtProvider: { templateName: string; languageCode: string }[];
  }): Promise<TemplateSyncRun> {
    if (this.failNextCompleteSync) {
      this.failNextCompleteSync = false;
      return Promise.reject(new Error('database unavailable'));
    }
    const syncedAt = new Date().toISOString();
    const raise = (value: string | null) =>
      !value || value < params.run.startedAt ? params.run.startedAt : value;
    for (const update of params.rows) {
      const row = this.rows.find((candidate) => candidate.id === update.id)!;
      Object.assign(row, update.next, {
        statusEventAt: raise(row.statusEventAt),
        qualityEventAt: raise(row.qualityEventAt),
        categoryEventAt: raise(row.categoryEventAt),
      });
      this.lastSyncedAt.set(row.key, syncedAt);
      if (update.drift) this.driftAt.set(row.key, syncedAt);
    }
    Object.assign(params.run, {
      status: 'succeeded',
      finishedAt: syncedAt,
      providerTemplateCount: params.providerTemplateCount,
      updatedCount: params.updatedCount,
      unchangedCount: params.rows.length - params.updatedCount,
      missingKeys: params.missingKeys,
      unknownAtProvider: params.unknownAtProvider,
    });
    return Promise.resolve(params.run);
  }

  recordEvent(
    event: TemplateProviderEvent,
    decide: (rows: SyncedTemplateRow[]) => {
      outcome: TemplateEventOutcome;
      updates: { id: string; next: ProviderState }[];
    },
  ) {
    const normalize = (code: string) => code.replaceAll('-', '_');
    const rows = this.rows
      .filter(
        (row) =>
          row.templateName === event.templateName &&
          normalize(row.languageCode) === normalize(event.languageCode),
      )
      .map((row) => ({ ...row }));
    const decision =
      rows.length === 0
        ? { outcome: 'unregistered' as const, updates: [] }
        : decide(rows);
    if (this.events.some((entry) => entry.identityKey === event.identityKey)) {
      return Promise.resolve({ duplicate: true as const });
    }
    this.events.push({
      identityKey: event.identityKey,
      outcome: decision.outcome,
      templateId: rows[0]?.id ?? null,
    });
    for (const update of decision.updates) {
      const row = this.rows.find((candidate) => candidate.id === update.id)!;
      Object.assign(row, update.next, {
        [EVENT_AT[event.field]]: event.occurredAt,
      });
    }
    return Promise.resolve({
      duplicate: false as const,
      outcome: decision.outcome,
      before: rows,
      updates: decision.updates,
    });
  }

  activeStoreCountsByKey(
    keys: readonly string[],
  ): Promise<Map<string, number>> {
    return Promise.resolve(
      new Map(
        keys
          .filter((key) => this.storeCounts.has(key))
          .map((key) => [key, this.storeCounts.get(key)!]),
      ),
    );
  }
}
