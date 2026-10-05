import type { AdminTemplateMetricsRow } from './admin-query.repository';
import { AdminTemplateMetricsService } from './admin-template-metrics.service';

function row(
  overrides: Partial<AdminTemplateMetricsRow> = {},
): AdminTemplateMetricsRow {
  return {
    variant_key: 'ar.egyptian',
    template_name: 'akeed_cod_verification_direct_eg',
    language_code: 'ar_EG',
    language: 'ar',
    sends: 0,
    sends_initial: 0,
    sends_reminder: 0,
    sends_test: 0,
    delivered: 0,
    read: 0,
    confirmed: 0,
    canceled: 0,
    no_reply: 0,
    ...overrides,
  };
}

function setup(rows: AdminTemplateMetricsRow[] = []) {
  const repository = {
    findTemplateMetrics: jest.fn().mockResolvedValue(rows),
  };
  const service = new AdminTemplateMetricsService(repository as never);
  return { repository, service };
}

describe('AdminTemplateMetricsService', () => {
  it('asks for the whole UTC days of the range, without test sends', async () => {
    const { repository, service } = setup();

    await service.getMetrics({ from: '2026-09-01', to: '2026-09-30' });

    expect(repository.findTemplateMetrics).toHaveBeenCalledWith({
      from: '2026-09-01T00:00:00.000Z',
      toExclusive: '2026-10-01T00:00:00.000Z',
      includeTest: false,
    });
  });

  it('includes test sends only when asked', async () => {
    const { repository, service } = setup();

    const response = await service.getMetrics({
      from: '2026-09-01',
      to: '2026-09-30',
      include_test: true,
    });

    expect(repository.findTemplateMetrics).toHaveBeenCalledWith(
      expect.objectContaining({ includeTest: true }),
    );
    expect(response.include_test).toBe(true);
  });

  it('reports each template and language with its sends and outcomes', async () => {
    const { service } = setup([
      row({
        // The driver may hand counts back as strings.
        sends: '12',
        sends_initial: '8',
        sends_reminder: '3',
        sends_test: '1',
        delivered: '11',
        read: '9',
        confirmed: '6',
        canceled: '2',
        no_reply: '3',
      }),
      row({
        variant_key: 'en.friendly',
        template_name: 'akeed_cod_verification_friendly',
        language_code: 'en',
        language: 'en',
        sends: 4,
        sends_initial: 4,
        delivered: 4,
        read: 1,
        confirmed: 1,
      }),
    ]);

    const response = await service.getMetrics({
      from: '2026-09-01',
      to: '2026-09-30',
    });

    expect(response.range).toEqual({
      from: '2026-09-01',
      to: '2026-09-30',
      timezone: 'UTC',
    });
    expect(response.templates).toEqual([
      {
        variant_key: 'ar.egyptian',
        template_name: 'akeed_cod_verification_direct_eg',
        language: 'ar',
        language_code: 'ar_EG',
        sends: { total: 12, initial: 8, reminder: 3, test: 1 },
        delivered: 11,
        read: 9,
        replies: 8,
        confirmed: 6,
        canceled: 2,
        no_reply: 3,
      },
      {
        variant_key: 'en.friendly',
        template_name: 'akeed_cod_verification_friendly',
        language: 'en',
        language_code: 'en',
        sends: { total: 4, initial: 4, reminder: 0, test: 0 },
        delivered: 4,
        read: 1,
        replies: 1,
        confirmed: 1,
        canceled: 0,
        no_reply: 0,
      },
    ]);
    expect(typeof response.evaluated_at).toBe('string');
  });

  it('keeps sends without a recorded template out of every template', async () => {
    const { service } = setup([
      row({ sends: 5, sends_initial: 5, confirmed: 2 }),
      row({
        variant_key: null,
        template_name: null,
        language_code: null,
        language: null,
        sends: 40,
        delivered: 38,
        read: 30,
        confirmed: 20,
        canceled: 4,
        no_reply: 9,
      }),
    ]);

    const response = await service.getMetrics({
      from: '2026-09-01',
      to: '2026-09-30',
    });

    expect(response.templates).toHaveLength(1);
    expect(response.templates[0]).toMatchObject({
      variant_key: 'ar.egyptian',
      sends: { total: 5, initial: 5, reminder: 0, test: 0 },
      confirmed: 2,
    });
    expect(response.not_recorded).toEqual({
      sends: { total: 40, initial: 0, reminder: 0, test: 0 },
      delivered: 38,
      read: 30,
      replies: 24,
      confirmed: 20,
      canceled: 4,
      no_reply: 9,
    });
  });

  it('answers an empty range with no templates and zero counts', async () => {
    const { service } = setup([]);

    const response = await service.getMetrics({
      from: '2026-01-01',
      to: '2026-01-01',
    });

    expect(response.templates).toEqual([]);
    expect(response.not_recorded).toEqual({
      sends: { total: 0, initial: 0, reminder: 0, test: 0 },
      delivered: 0,
      read: 0,
      replies: 0,
      confirmed: 0,
      canceled: 0,
      no_reply: 0,
    });
  });

  it.each([
    ['a range that ends before it starts', '2026-09-02', '2026-09-01'],
    ['a range longer than 92 days', '2026-07-01', '2026-10-01'],
    ['a date that does not exist', '2026-02-30', '2026-03-01'],
  ])('refuses %s with a coded 400 and reads nothing', async (_l, from, to) => {
    const { repository, service } = setup();

    await expect(service.getMetrics({ from, to })).rejects.toMatchObject({
      status: 400,
      response: {
        statusCode: 400,
        code: 'ADMIN_TEMPLATE_METRICS_RANGE_INVALID',
      },
    });
    expect(repository.findTemplateMetrics).not.toHaveBeenCalled();
  });
});
