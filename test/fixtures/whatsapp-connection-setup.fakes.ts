/**
 * In-memory stand-ins for the connection and connection-template
 * repositories, with the same claim rules as their SQL. The contract suite
 * proves the SQL itself against PostgreSQL.
 */
import type {
  DueSetup,
  SetupClaim,
  SetupProgressPatch,
  SetupRelease,
  WhatsappConnectionRecord,
} from '../../src/infrastructure/database/repositories/whatsapp-connections.repository';
import type {
  WhatsappConnectionTemplatePatch,
  WhatsappConnectionTemplateRecord,
} from '../../src/infrastructure/database/repositories/whatsapp-connection-templates.repository';
import type { InspectedTemplate } from '../../src/infrastructure/database/repositories/whatsapp-templates.repository';

const iso = (ms = Date.now()) => new Date(ms).toISOString();

export function connectionRow(
  overrides: Partial<WhatsappConnectionRecord> = {},
): WhatsappConnectionRecord {
  return {
    id: 'conn-1',
    orgId: 'org-1',
    wabaId: '102290129340398',
    phoneNumberId: '106540352242922',
    displayPhoneNumber: '+20 100 555 0101',
    signupPath: 'new_number',
    state: 'connecting',
    stateReason: null,
    businessTokenEncrypted: null,
    registrationPinEncrypted: null,
    degradedClass: null,
    degradedSince: null,
    qualityRating: null,
    nameStatus: null,
    lastHealthAt: null,
    thankYouEnabled: true,
    connectedAt: iso(),
    disconnectedAt: null,
    signupGeneration: 1,
    setupStatus: 'pending',
    setupStep: 'subscribe',
    setupAttempts: 0,
    setupLeaseUntil: null,
    setupNextAttemptAt: iso(Date.now() - 1_000),
    setupErrorCode: null,
    subscribedAt: null,
    numberVerifiedAt: null,
    registeredAt: null,
    setupCompletedAt: null,
    providerIsOnBizApp: null,
    providerPlatformType: null,
    createdAt: iso(),
    updatedAt: iso(),
    ...overrides,
  };
}

export class InMemoryConnections {
  readonly rows = new Map<string, WhatsappConnectionRecord>();
  readonly writes: string[] = [];

  add(row: WhatsappConnectionRecord): WhatsappConnectionRecord {
    this.rows.set(row.id, { ...row });
    return this.rows.get(row.id)!;
  }

  get(id: string): WhatsappConnectionRecord {
    return this.rows.get(id)!;
  }

  findById = jest.fn((id: string) =>
    Promise.resolve(this.copy(this.rows.get(id))),
  );

  findByOrg = jest.fn((orgId: string) =>
    Promise.resolve(
      this.copy([...this.rows.values()].find((r) => r.orgId === orgId)),
    ),
  );

  findLiveByWabaId = jest.fn((wabaId: string) =>
    Promise.resolve(
      this.copy(
        [...this.rows.values()].find(
          (r) => r.wabaId === wabaId && r.state !== 'disconnected',
        ),
      ),
    ),
  );

  findDueSetups = jest.fn(
    (limit: number): Promise<DueSetup[]> =>
      Promise.resolve(
        [...this.rows.values()]
          .filter((r) => r.state === 'connecting' && this.due(r))
          .slice(0, limit)
          .map((r) => ({ id: r.id, signupGeneration: r.signupGeneration })),
      ),
  );

  claimSetup = jest.fn((id: string, generation: number, leaseMs: number) => {
    const row = this.rows.get(id);
    if (
      !row ||
      row.signupGeneration !== generation ||
      row.state !== 'connecting' ||
      !this.due(row)
    )
      return Promise.resolve(null);
    row.setupStatus = 'running';
    row.setupLeaseUntil = iso(Date.now() + leaseMs);
    row.setupAttempts += 1;
    this.writes.push('claim');
    return Promise.resolve(this.copy(row));
  });

  recordSetupProgress = jest.fn(
    (claim: SetupClaim, patch: SetupProgressPatch) => {
      const row = this.held(claim);
      if (!row) return Promise.resolve(null);
      if (patch.setupStep) row.setupStep = patch.setupStep;
      if (patch.subscribedAt) row.subscribedAt = iso();
      if (patch.numberVerifiedAt) row.numberVerifiedAt = iso();
      if (patch.registeredAt) row.registeredAt = iso();
      if (patch.providerIsOnBizApp !== undefined)
        row.providerIsOnBizApp = patch.providerIsOnBizApp;
      if (patch.providerPlatformType !== undefined)
        row.providerPlatformType = patch.providerPlatformType;
      row.setupErrorCode = null;
      this.writes.push(`progress:${patch.setupStep ?? '-'}`);
      return Promise.resolve(this.copy(row));
    },
  );

  storeRegistrationPinOnce = jest.fn((claim: SetupClaim, pin: string) => {
    const row = this.held(claim);
    if (!row) return Promise.resolve(null);
    row.registrationPinEncrypted ??= pin;
    this.writes.push('pin');
    return Promise.resolve(this.copy(row));
  });

  releaseSetup = jest.fn((claim: SetupClaim, release: SetupRelease) => {
    const row = this.held(claim);
    if (!row) return Promise.resolve(null);
    row.setupStatus = release.status;
    row.setupErrorCode = release.errorCode;
    row.setupNextAttemptAt = release.nextAttemptAt
      ? release.nextAttemptAt.toISOString()
      : null;
    row.setupLeaseUntil = null;
    if (release.status === 'pending') row.setupAttempts = 0;
    this.writes.push(`release:${release.status}`);
    return Promise.resolve(this.copy(row));
  });

  completeSetup = jest.fn((claim: SetupClaim) => {
    const row = this.held(claim);
    if (!row) return Promise.resolve(null);
    Object.assign(row, {
      state: 'verifying',
      setupStatus: 'complete',
      setupStep: 'done',
      setupErrorCode: null,
      setupLeaseUntil: null,
      setupNextAttemptAt: null,
      setupCompletedAt: iso(),
    });
    this.writes.push('complete');
    return Promise.resolve(this.copy(row));
  });

  findForTemplateSync = jest.fn(() =>
    Promise.resolve(
      [...this.rows.values()]
        .filter(
          (r) =>
            ['connecting', 'verifying', 'active'].includes(r.state) &&
            r.numberVerifiedAt,
        )
        .map((r) => ({ id: r.id, signupGeneration: r.signupGeneration })),
    ),
  );

  /** Lets the next attempt run now, as if its retry delay had passed. */
  makeDue(id: string): void {
    this.get(id).setupNextAttemptAt = iso(Date.now() - 1_000);
  }

  private due(row: WhatsappConnectionRecord): boolean {
    if (row.setupStatus === 'pending' || row.setupStatus === 'failed')
      return (
        row.setupNextAttemptAt !== null &&
        Date.parse(row.setupNextAttemptAt) <= Date.now()
      );
    if (row.setupStatus === 'running')
      return (
        row.setupLeaseUntil !== null &&
        Date.parse(row.setupLeaseUntil) < Date.now()
      );
    return false;
  }

  private held(claim: SetupClaim): WhatsappConnectionRecord | null {
    const row = this.rows.get(claim.id);
    return row &&
      row.signupGeneration === claim.signupGeneration &&
      row.setupAttempts === claim.setupAttempts &&
      row.state === 'connecting' &&
      row.setupStatus === 'running'
      ? row
      : null;
  }

  private copy(
    row: WhatsappConnectionRecord | undefined,
  ): WhatsappConnectionRecord | null {
    return row ? { ...row } : null;
  }
}

export class InMemoryConnectionTemplates {
  readonly rows: WhatsappConnectionTemplateRecord[] = [];
  private nextId = 1;

  listForConnection = jest.fn((orgId: string, connectionId: string) =>
    Promise.resolve(
      this.rows
        .filter((r) => r.orgId === orgId && r.connectionId === connectionId)
        .map((r) => ({ ...r })),
    ),
  );

  ensureRows = jest.fn(
    (
      orgId: string,
      connectionId: string,
      templates: readonly { templateId: string; metaLanguageCode: string }[],
    ) => {
      let added = 0;
      for (const t of templates) {
        if (
          this.rows.some(
            (r) =>
              r.connectionId === connectionId && r.templateId === t.templateId,
          )
        )
          continue;
        added += 1;
        this.rows.push(
          templateRow(orgId, connectionId, t, `row-${this.nextId++}`),
        );
      }
      return Promise.resolve(added);
    },
  );

  claimForSubmission = jest.fn((orgId: string, id: string, leaseMs: number) => {
    const row = this.rows.find((r) => r.orgId === orgId && r.id === id);
    if (
      !row ||
      !['not_submitted', 'failed', 'missing'].includes(row.status) ||
      (row.nextAttemptAt !== null && Date.parse(row.nextAttemptAt) > Date.now())
    )
      return Promise.resolve(null);
    row.status = 'submitting';
    row.leaseUntil = iso(Date.now() + leaseMs);
    row.attempts += 1;
    return Promise.resolve({ ...row });
  });

  updateForOrg = jest.fn(
    (
      orgId: string,
      id: string,
      patch: WhatsappConnectionTemplatePatch,
      expectedAttempts?: number,
    ) => {
      const row = this.rows.find((r) => r.orgId === orgId && r.id === id);
      if (
        !row ||
        (expectedAttempts !== undefined && row.attempts !== expectedAttempts)
      )
        return Promise.resolve(null);
      const { driftAt, lastSyncedAt, submittedAt, ...rest } = patch;
      Object.assign(row, rest);
      if (driftAt !== undefined)
        row.driftAt = driftAt === 'now' ? iso() : driftAt;
      if (lastSyncedAt) row.lastSyncedAt = iso();
      if (submittedAt !== undefined)
        row.submittedAt = submittedAt === 'now' ? iso() : submittedAt;
      return Promise.resolve({ ...row });
    },
  );

  applyStatusHint = jest.fn(
    (
      orgId: string,
      connectionId: string,
      hint: { metaTemplateId: string; status: string; occurredAt: string },
    ) => {
      const row = this.rows.find(
        (r) =>
          r.orgId === orgId &&
          r.connectionId === connectionId &&
          r.metaTemplateId === hint.metaTemplateId &&
          (r.statusEventAt === null || r.statusEventAt < hint.occurredAt),
      );
      if (!row) return Promise.resolve(false);
      row.status = hint.status;
      row.statusEventAt = hint.occurredAt;
      return Promise.resolve(true);
    },
  );

  byTemplate(templateId: string): WhatsappConnectionTemplateRecord | undefined {
    return this.rows.find((r) => r.templateId === templateId);
  }
}

function templateRow(
  orgId: string,
  connectionId: string,
  t: { templateId: string; metaLanguageCode: string },
  id: string,
): WhatsappConnectionTemplateRecord {
  return {
    id,
    connectionId,
    orgId,
    templateId: t.templateId,
    metaTemplateId: null,
    metaLanguageCode: t.metaLanguageCode,
    status: 'not_submitted',
    category: null,
    quality: null,
    rejectionReason: null,
    submittedAt: null,
    statusEventAt: null,
    lastError: null,
    attempts: 0,
    nextAttemptAt: null,
    leaseUntil: null,
    submittedComponentsHash: null,
    driftAt: null,
    driftReason: null,
    lastSyncedAt: null,
    lastErrorCode: null,
    createdAt: iso(),
    updatedAt: iso(),
  };
}

/** The registry as the template services read it. */
export function registryFake(
  templates: InspectedTemplate[],
  retired: string[] = [],
) {
  return {
    findAllForInspection: jest.fn(() => Promise.resolve(templates)),
    findRetiredKeys: jest.fn(() => Promise.resolve(retired)),
  };
}
