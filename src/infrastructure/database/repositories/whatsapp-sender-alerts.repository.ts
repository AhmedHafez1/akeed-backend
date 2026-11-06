import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../database.provider';
import { whatsappConnections, whatsappSenderAlerts } from '../schema';
import { withSerializableRetry } from '../../../shared/database/serializable-retry';
import {
  senderAlerts,
  suppressFallbackEmail,
  type SenderAlert,
  type SenderAlertTemplate,
  type SenderAlertFacts,
} from '../../../shared/notifications/sender-alert.policy';

type QueryDb = Pick<DrizzleDB, 'select' | 'execute'>;
type Incident = typeof whatsappSenderAlerts.$inferSelect;
type Connection = typeof whatsappConnections.$inferSelect;

@Injectable()
export class WhatsappSenderAlertsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  async listConnections(after?: string) {
    return this.db
      .select({
        id: whatsappConnections.id,
        orgId: whatsappConnections.orgId,
        signupGeneration: whatsappConnections.signupGeneration,
      })
      .from(whatsappConnections)
      .where(after ? gt(whatsappConnections.id, after) : undefined)
      .orderBy(asc(whatsappConnections.id))
      .limit(50);
  }

  /** Uses aliases rather than db.query fragments, which rebind cross-table columns. */
  private async facts(
    db: QueryDb,
    connection: Connection,
  ): Promise<SenderAlertFacts> {
    const templates = await db.execute<
      SenderAlertTemplate & Record<string, unknown>
    >(sql`
      SELECT t.key, ct.meta_language_code AS language, ct.status, ct.category
      FROM whatsapp_connection_templates ct JOIN whatsapp_templates t ON t.id = ct.template_id
      WHERE ct.org_id = ${connection.orgId} AND ct.connection_id = ${connection.id}
        AND t.is_active = true AND t.review_status = 'approved' AND t.header_format = 'none'
        AND t.retired_at IS NULL
      ORDER BY t.key, ct.meta_language_code
    `);
    const activity = await db.execute<{
      reason: string;
      at: string;
      sender: string;
    }>(sql`
      SELECT d.sender_reason AS reason, d.accepted_at::text AS at, d.sender_kind AS sender
      FROM verification_message_dispatches d
      LEFT JOIN verification_message_dispatches source ON source.id = d.fallback_for_dispatch_id AND source.org_id = d.org_id
      WHERE d.org_id = ${connection.orgId} AND d.state = 'accepted' AND d.failed_at IS NULL
        AND d.accepted_at >= COALESCE(${connection.connectedAt}::timestamptz, ${connection.createdAt}::timestamptz)
        AND (
          (d.sender_kind = 'merchant_own' AND d.sender_connection_id = ${connection.id} AND d.sender_connection_generation = ${connection.signupGeneration})
          OR (d.sender_kind = 'akeed_system' AND d.sender_reason IN ('disconnected','offboarded','not_ready','template_missing','template_pending','template_rejected','template_paused','template_recategorized','degraded:credentials','degraded:payment','degraded:restricted'))
          OR (d.sender_kind = 'akeed_system' AND source.sender_connection_id = ${connection.id} AND source.sender_connection_generation = ${connection.signupGeneration}
            AND EXISTS (SELECT 1 FROM verification_sender_attempts attempt WHERE attempt.dispatch_id = source.id AND attempt.org_id = d.org_id
              AND attempt.attempt_number = (SELECT max(a.attempt_number) FROM verification_sender_attempts a WHERE a.dispatch_id = source.id AND a.org_id = d.org_id)
              AND attempt.failure->>'class' NOT IN ('payload','unknown','recipient')))
        )
      ORDER BY d.accepted_at DESC, (d.sender_kind = 'akeed_system') DESC, d.id DESC LIMIT 1
    `);
    const latest = activity[0];
    return {
      ...connection,
      templates: [...templates],
      fallback:
        latest?.sender === 'akeed_system'
          ? { reason: latest.reason, at: latest.at }
          : null,
      merchantAcceptedAt: latest?.sender === 'merchant_own' ? latest.at : null,
    };
  }

  /** Read-only: no email history is required to display a current banner. */
  async read(orgId: string, sendingEnabled: boolean): Promise<SenderAlert[]> {
    const [connection] = await this.db
      .select()
      .from(whatsappConnections)
      .where(eq(whatsappConnections.orgId, orgId))
      .limit(1);
    return connection
      ? senderAlerts(await this.facts(this.db, connection), sendingEnabled)
      : [];
  }

  /** One connection row per org also serializes incident changes and fallback claims. */
  async reconcile(
    orgId: string,
    sendingEnabled: boolean,
    generation?: number,
  ): Promise<Incident[]> {
    return withSerializableRetry(() =>
      this.db.transaction(async (tx) => {
        const [connection] = await tx
          .select()
          .from(whatsappConnections)
          .where(eq(whatsappConnections.orgId, orgId))
          .for('update');
        if (
          !connection ||
          (generation !== undefined &&
            connection.signupGeneration !== generation)
        )
          return [];
        const current = senderAlerts(
          await this.facts(tx, connection),
          sendingEnabled,
        );
        const open = await tx
          .select()
          .from(whatsappSenderAlerts)
          .where(
            and(
              eq(whatsappSenderAlerts.orgId, orgId),
              isNull(whatsappSenderAlerts.resolvedAt),
            ),
          );
        for (const incident of open) {
          if (
            incident.signupGeneration !== connection.signupGeneration ||
            !current.some((a) => a.kind === incident.kind)
          )
            await tx
              .update(whatsappSenderAlerts)
              .set({ resolvedAt: sql`now()` })
              .where(
                and(
                  eq(whatsappSenderAlerts.orgId, orgId),
                  eq(whatsappSenderAlerts.id, incident.id),
                ),
              );
        }
        for (const alert of current) {
          await tx
            .insert(whatsappSenderAlerts)
            .values({
              orgId,
              connectionId: connection.id,
              signupGeneration: connection.signupGeneration,
              kind: alert.kind,
              reason: alert.reason,
              dedupeKey: 'connection',
            })
            .onConflictDoNothing();
        }
        return tx
          .select()
          .from(whatsappSenderAlerts)
          .where(
            and(
              eq(whatsappSenderAlerts.orgId, orgId),
              eq(
                whatsappSenderAlerts.signupGeneration,
                connection.signupGeneration,
              ),
              isNull(whatsappSenderAlerts.resolvedAt),
              eq(whatsappSenderAlerts.emailStatus, 'pending'),
            ),
          );
      }),
    );
  }

  async claimEmail(
    orgId: string,
    id: string,
    sendingEnabled: boolean,
    skipReason?: string,
  ): Promise<SenderAlert | null> {
    return withSerializableRetry(() =>
      this.db.transaction(async (tx) => {
        const [connection] = await tx
          .select()
          .from(whatsappConnections)
          .where(eq(whatsappConnections.orgId, orgId))
          .for('update');
        if (!connection) return null;
        const [incident] = await tx
          .select()
          .from(whatsappSenderAlerts)
          .where(
            and(
              eq(whatsappSenderAlerts.orgId, orgId),
              eq(whatsappSenderAlerts.id, id),
              isNull(whatsappSenderAlerts.resolvedAt),
              eq(whatsappSenderAlerts.emailStatus, 'pending'),
            ),
          );
        if (!incident) return null;
        const alerts = senderAlerts(
          await this.facts(tx, connection),
          sendingEnabled,
        );
        const alert = alerts.find((a) => a.kind === incident.kind);
        if (
          incident.signupGeneration !== connection.signupGeneration ||
          !alert
        ) {
          await tx
            .update(whatsappSenderAlerts)
            .set({ resolvedAt: sql`now()` })
            .where(
              and(
                eq(whatsappSenderAlerts.orgId, orgId),
                eq(whatsappSenderAlerts.id, id),
              ),
            );
          return null;
        }
        let reason = skipReason;
        if (alert.kind === 'fallback') {
          if (suppressFallbackEmail(alerts)) reason ??= 'specific_cause';
          const [recent] = await tx
            .select({ id: whatsappSenderAlerts.id })
            .from(whatsappSenderAlerts)
            .where(
              and(
                eq(whatsappSenderAlerts.orgId, orgId),
                eq(whatsappSenderAlerts.kind, 'fallback'),
                sql`${whatsappSenderAlerts.emailClaimedAt} > now() - interval '24 hours'`,
              ),
            )
            .limit(1);
          if (recent) reason ??= 'rate_limited';
        }
        await tx
          .update(whatsappSenderAlerts)
          .set({
            reason: alert.reason,
            emailStatus: reason ? 'skipped' : 'sending',
            emailError: reason ?? null,
            emailClaimedAt: reason ? null : sql`now()`,
          })
          .where(
            and(
              eq(whatsappSenderAlerts.orgId, orgId),
              eq(whatsappSenderAlerts.id, id),
            ),
          );
        return reason ? null : alert;
      }),
    );
  }

  async markEmail(
    orgId: string,
    id: string,
    status: 'sent' | 'failed' | 'skipped',
    reason?: string,
  ) {
    await this.db
      .update(whatsappSenderAlerts)
      .set({
        emailStatus: status,
        emailError: reason ?? null,
        emailedAt: status === 'sent' ? sql`now()` : null,
      })
      .where(
        and(
          eq(whatsappSenderAlerts.orgId, orgId),
          eq(whatsappSenderAlerts.id, id),
          eq(whatsappSenderAlerts.emailStatus, 'sending'),
        ),
      );
  }
}
