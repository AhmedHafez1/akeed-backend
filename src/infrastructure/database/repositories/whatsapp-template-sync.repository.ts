import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../database.provider';
import {
  integrations,
  organizations,
  whatsappTemplateEvents,
  whatsappTemplateSyncRuns,
  whatsappTemplates,
} from '../schema';
import type {
  TemplateCategory,
  TemplateComponentsSnapshot,
  ProviderState,
  SyncedTemplateRow,
  TemplateProviderEvent,
  TemplateQuality,
  TemplateReviewStatus,
} from '../../../shared/messaging/template-provider.types';

export type TemplateSyncTrigger = 'scheduled' | 'manual' | 'webhook';

export type TemplateSyncRun = typeof whatsappTemplateSyncRuns.$inferSelect;

export type TemplateEventOutcome =
  | 'applied'
  | 'stale'
  | 'conflict'
  | 'unregistered';

export type TemplateEventRecord = Pick<
  typeof whatsappTemplateEvents.$inferSelect,
  'id' | 'field' | 'neutralValue' | 'outcome' | 'occurredAt' | 'receivedAt'
>;

/** An active store that sends a template, as staff see it. */
export interface TemplateStoreUse {
  integrationId: string;
  storeName: string | null;
  platformType: string;
  storeUrl: string;
  defaultLanguage: string;
}

type DrizzleWriter = Parameters<Parameters<DrizzleDB['transaction']>[0]>[0];

/** A run still `running` after this long is taken to have died. */
export const ABANDONED_SYNC_RUN_MS = 15 * 60_000;

const ROW_COLUMNS = {
  id: whatsappTemplates.id,
  key: whatsappTemplates.key,
  purpose: whatsappTemplates.purpose,
  isActive: whatsappTemplates.isActive,
  isDefault: whatsappTemplates.isDefault,
  templateName: whatsappTemplates.metaTemplateName,
  languageCode: whatsappTemplates.metaLanguageCode,
  providerTemplateId: whatsappTemplates.metaTemplateId,
  reviewStatus: whatsappTemplates.reviewStatus,
  category: whatsappTemplates.category,
  pendingCategory: whatsappTemplates.pendingCategory,
  quality: whatsappTemplates.quality,
  components: whatsappTemplates.componentsSnapshot,
  statusEventAt: whatsappTemplates.statusEventAt,
  qualityEventAt: whatsappTemplates.qualityEventAt,
  categoryEventAt: whatsappTemplates.categoryEventAt,
};

function toSyncedRow(row: {
  [K in keyof typeof ROW_COLUMNS]: unknown;
}): SyncedTemplateRow {
  return {
    ...(row as unknown as SyncedTemplateRow),
    reviewStatus: row.reviewStatus as TemplateReviewStatus | null,
    category: row.category as TemplateCategory | null,
    pendingCategory: row.pendingCategory as TemplateCategory | null,
    quality: row.quality as TemplateQuality | null,
    components: row.components as TemplateComponentsSnapshot | null,
  };
}

function stateColumns(state: ProviderState) {
  return {
    metaTemplateId: state.providerTemplateId,
    reviewStatus: state.reviewStatus,
    category: state.category,
    pendingCategory: state.pendingCategory,
    quality: state.quality,
    componentsSnapshot: state.components,
  };
}

/**
 * The registry key a store sends for each language. A store with no stored
 * key is read from its old variant column, which is what its sends use while
 * that column exists (US-08-03).
 */
export const STORE_AR_KEY = sql<string>`COALESCE(${integrations.codTemplateArKey}, 'cod_confirm.ar.' || ${integrations.codTemplateArVariant})`;
export const STORE_EN_KEY = sql<string>`COALESCE(${integrations.codTemplateEnKey}, 'cod_confirm.en.' || ${integrations.codTemplateEnVariant})`;

const EVENT_AT_FIELD = {
  status: 'statusEventAt',
  quality: 'qualityEventAt',
  category: 'categoryEventAt',
} as const;

/**
 * Writes the provider-side state of the template registry: sync runs, synced
 * rows and template events. Like `whatsapp_templates`, these tables are
 * global; every template belongs to Akeed's one sender.
 */
@Injectable()
export class WhatsappTemplateSyncRepository {
  constructor(
    @Inject(DRIZZLE)
    private readonly db: DrizzleDB,
  ) {}

  /**
   * Opens a run, or returns null while another run is in progress. A run left
   * `running` for longer than `ABANDONED_SYNC_RUN_MS` is closed as
   * `abandoned` first, so a crashed worker cannot block sync for good.
   */
  async startRun(
    trigger: TemplateSyncTrigger,
    requestedBy: string | null,
    now: Date = new Date(),
  ): Promise<TemplateSyncRun | null> {
    await this.db
      .update(whatsappTemplateSyncRuns)
      .set({
        status: 'failed',
        errorCode: 'abandoned',
        finishedAt: now.toISOString(),
      })
      .where(
        and(
          eq(whatsappTemplateSyncRuns.status, 'running'),
          lt(
            whatsappTemplateSyncRuns.startedAt,
            new Date(now.getTime() - ABANDONED_SYNC_RUN_MS).toISOString(),
          ),
        ),
      );
    const [run] = await this.db
      .insert(whatsappTemplateSyncRuns)
      .values({
        trigger,
        requestedBy,
        status: 'running',
        startedAt: now.toISOString(),
      })
      .onConflictDoNothing()
      .returning();
    return run ?? null;
  }

  async failRun(id: string, errorCode: string): Promise<TemplateSyncRun> {
    const [run] = await this.db
      .update(whatsappTemplateSyncRuns)
      .set({
        status: 'failed',
        errorCode,
        finishedAt: new Date().toISOString(),
      })
      .where(eq(whatsappTemplateSyncRuns.id, id))
      .returning();
    return run;
  }

  async recentRuns(limit: number): Promise<TemplateSyncRun[]> {
    return this.db
      .select()
      .from(whatsappTemplateSyncRuns)
      .orderBy(desc(whatsappTemplateSyncRuns.startedAt))
      .limit(limit);
  }

  /** The newest finished run, failed or not. */
  async lastFinishedRun(): Promise<TemplateSyncRun | null> {
    const [run] = await this.db
      .select()
      .from(whatsappTemplateSyncRuns)
      .where(sql`${whatsappTemplateSyncRuns.status} <> 'running'`)
      .orderBy(desc(whatsappTemplateSyncRuns.finishedAt))
      .limit(1);
    return run ?? null;
  }

  async listRows(): Promise<SyncedTemplateRow[]> {
    const rows = await this.db.select(ROW_COLUMNS).from(whatsappTemplates);
    return rows.map(toSyncedRow);
  }

  /**
   * Applies a planned sync and closes the run, in one transaction. Every row
   * gets `last_synced_at`, and each `*_event_at` is raised to the run's start
   * so a webhook older than this sync can no longer overwrite it.
   */
  async completeSync(params: {
    run: TemplateSyncRun;
    rows: {
      id: string;
      next: ProviderState;
      drift: boolean;
      /** Why review rejected it; undefined leaves the stored reason. */
      rejectionReason?: string | null;
    }[];
    providerTemplateCount: number;
    updatedCount: number;
    missingKeys: string[];
    unknownAtProvider: { templateName: string; languageCode: string }[];
  }): Promise<TemplateSyncRun> {
    return this.db.transaction(async (tx) => {
      const syncedAt = new Date().toISOString();
      const startedAt = params.run.startedAt;
      for (const row of params.rows) {
        await tx
          .update(whatsappTemplates)
          .set({
            ...stateColumns(row.next),
            lastSyncedAt: syncedAt,
            updatedAt: syncedAt,
            statusEventAt: sql`GREATEST(${whatsappTemplates.statusEventAt}, ${startedAt}::timestamptz)`,
            qualityEventAt: sql`GREATEST(${whatsappTemplates.qualityEventAt}, ${startedAt}::timestamptz)`,
            categoryEventAt: sql`GREATEST(${whatsappTemplates.categoryEventAt}, ${startedAt}::timestamptz)`,
            ...(row.drift ? { componentsDriftAt: syncedAt } : {}),
            ...(row.rejectionReason !== undefined
              ? { rejectionReason: row.rejectionReason }
              : {}),
          })
          .where(eq(whatsappTemplates.id, row.id));
      }
      const [run] = await tx
        .update(whatsappTemplateSyncRuns)
        .set({
          status: 'succeeded',
          finishedAt: syncedAt,
          providerTemplateCount: params.providerTemplateCount,
          updatedCount: params.updatedCount,
          unchangedCount: params.rows.length - params.updatedCount,
          missingKeys: params.missingKeys,
          unknownAtProvider: params.unknownAtProvider,
        })
        .where(eq(whatsappTemplateSyncRuns.id, params.run.id))
        .returning();
      return run;
    });
  }

  /**
   * Records one provider event and, inside the same transaction, lets
   * `decide` choose what it does to the rows it names. The rows are locked
   * while it decides. A redelivered event (same identity) changes nothing and
   * returns `duplicate`.
   */
  async recordEvent(
    event: TemplateProviderEvent,
    decide: (rows: SyncedTemplateRow[]) => {
      outcome: TemplateEventOutcome;
      updates: { id: string; next: ProviderState }[];
    },
  ): Promise<
    | { duplicate: true }
    | {
        duplicate: false;
        outcome: TemplateEventOutcome;
        before: SyncedTemplateRow[];
        updates: { id: string; next: ProviderState }[];
      }
  > {
    return this.db.transaction(async (tx) => {
      const rows = await this.lockRows(tx, event);
      const decision =
        rows.length === 0
          ? { outcome: 'unregistered' as const, updates: [] }
          : decide(rows);
      const [inserted] = await tx
        .insert(whatsappTemplateEvents)
        .values({
          templateId: rows[0]?.id ?? null,
          field: event.field,
          identityKey: event.identityKey,
          providerTemplateName: event.templateName,
          providerLanguageCode: event.languageCode,
          providerTemplateId: event.providerTemplateId,
          occurredAt: event.occurredAt,
          neutralValue: neutralValue(event),
          outcome: decision.outcome,
        })
        .onConflictDoNothing({ target: whatsappTemplateEvents.identityKey })
        .returning({ id: whatsappTemplateEvents.id });
      if (!inserted) return { duplicate: true as const };
      for (const update of decision.updates) {
        await tx
          .update(whatsappTemplates)
          .set({
            ...stateColumns(update.next),
            ...(event.field === 'status' && event.rejectionReason !== undefined
              ? { rejectionReason: event.rejectionReason }
              : {}),
            [EVENT_AT_FIELD[event.field]]: event.occurredAt,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(whatsappTemplates.id, update.id));
      }
      return {
        duplicate: false as const,
        outcome: decision.outcome,
        before: rows,
        updates: decision.updates,
      };
    });
  }

  private async lockRows(
    tx: DrizzleWriter,
    event: TemplateProviderEvent,
  ): Promise<SyncedTemplateRow[]> {
    const rows = await tx
      .select(ROW_COLUMNS)
      .from(whatsappTemplates)
      .where(
        and(
          eq(whatsappTemplates.metaTemplateName, event.templateName),
          eq(
            sql`replace(${whatsappTemplates.metaLanguageCode}, '-', '_')`,
            event.languageCode.replaceAll('-', '_'),
          ),
        ),
      )
      .orderBy(whatsappTemplates.key)
      .for('update');
    return rows.map(toSyncedRow);
  }

  /**
   * How many active stores send each registry key, per language. A store with
   * no stored key is counted under the key of its old variant column, which
   * is what its sends read while that column exists (US-08-03).
   */
  async activeStoreCountsByKey(
    keys: readonly string[],
  ): Promise<Map<string, number>> {
    if (keys.length === 0) return new Map();
    const counts = new Map<string, number>();
    for (const expression of [STORE_AR_KEY, STORE_EN_KEY]) {
      const rows = await this.db
        .select({ key: expression, stores: sql<number>`count(*)::int` })
        .from(integrations)
        .where(
          and(eq(integrations.isActive, true), inArray(expression, [...keys])),
        )
        .groupBy(expression);
      for (const row of rows) {
        counts.set(row.key, (counts.get(row.key) ?? 0) + Number(row.stores));
      }
    }
    return counts;
  }

  /**
   * The active stores that send a registry key, by name, and how many there
   * are in all. A store is matched the way `activeStoreCountsByKey` counts it.
   */
  async activeStoresUsingKey(
    key: string,
    limit: number,
  ): Promise<{ total: number; stores: TemplateStoreUse[] }> {
    const uses = and(
      eq(integrations.isActive, true),
      or(eq(STORE_AR_KEY, key), eq(STORE_EN_KEY, key)),
    );
    const storeName = sql<
      string | null
    >`COALESCE(${integrations.storeName}, ${organizations.name})`;
    const [stores, [count]] = await Promise.all([
      this.db
        .select({
          integrationId: integrations.id,
          storeName,
          platformType: integrations.platformType,
          storeUrl: integrations.platformStoreUrl,
          defaultLanguage: integrations.defaultLanguage,
        })
        .from(integrations)
        .leftJoin(organizations, eq(organizations.id, integrations.orgId))
        .where(uses)
        .orderBy(asc(sql`lower(${storeName})`), asc(integrations.id))
        .limit(limit),
      this.db
        .select({ total: sql<number>`count(*)::int` })
        .from(integrations)
        .where(uses),
    ]);
    return { total: Number(count?.total ?? 0), stores };
  }

  /** The newest provider events recorded for one registry template. */
  async eventsForTemplate(
    templateId: string,
    limit: number,
  ): Promise<TemplateEventRecord[]> {
    return this.db
      .select({
        id: whatsappTemplateEvents.id,
        field: whatsappTemplateEvents.field,
        neutralValue: whatsappTemplateEvents.neutralValue,
        outcome: whatsappTemplateEvents.outcome,
        occurredAt: whatsappTemplateEvents.occurredAt,
        receivedAt: whatsappTemplateEvents.receivedAt,
      })
      .from(whatsappTemplateEvents)
      .where(eq(whatsappTemplateEvents.templateId, templateId))
      .orderBy(
        desc(whatsappTemplateEvents.occurredAt),
        desc(whatsappTemplateEvents.receivedAt),
      )
      .limit(limit);
  }
}

/** What an event said, in neutral values only: no provider text. */
function neutralValue(
  event: TemplateProviderEvent,
): Record<string, string | null> {
  switch (event.field) {
    case 'status':
      return { status: event.status ?? null };
    case 'quality':
      return { quality: event.quality ?? null };
    case 'category':
      return {
        category: event.category ?? null,
        pendingCategory: event.pendingCategory ?? null,
      };
  }
}
