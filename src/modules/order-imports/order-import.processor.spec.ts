import type { Job } from 'bullmq';
import { OrderImportProcessor } from './order-import.processor';

function setup() {
  const commit = {
    process: jest.fn().mockResolvedValue(undefined),
    onFailed: jest.fn().mockResolvedValue(undefined),
  };
  const release = { tick: jest.fn().mockResolvedValue({ kind: 'idle' }) };
  const expire = { run: jest.fn().mockResolvedValue({ expired: 0 }) };
  const purge = {
    run: jest.fn().mockResolvedValue({ draftsDeleted: 0, rowsPurged: 0 }),
  };
  const processor = new OrderImportProcessor(
    commit as never,
    release as never,
    expire as never,
    purge as never,
  );
  return { processor, commit, release, expire, purge };
}

const job = (name: string, data: Record<string, unknown>) =>
  ({ name, data, opts: {}, attemptsMade: 1 }) as unknown as Job;

describe('OrderImportProcessor', () => {
  it('routes each job by name', async () => {
    const { processor, commit, release, expire, purge } = setup();

    await processor.process(job('import.release', { orgId: 'org-1' }));
    await processor.process(job('import.expire', {}));
    await processor.process(job('import.purge', {}));
    const commitJob = job('import.commit', { orgId: 'org-1', batchId: 'b-1' });
    await processor.process(commitJob);

    expect(release.tick).toHaveBeenCalledWith('org-1');
    expect(expire.run).toHaveBeenCalledTimes(1);
    expect(purge.run).toHaveBeenCalledTimes(1);
    expect(commit.process).toHaveBeenCalledWith(commitJob);
  });

  it('fails only a commit terminally; a failed tick simply runs again', async () => {
    const { processor, commit } = setup();
    const error = new Error('boom');

    await processor.onFailed(job('import.release', { orgId: 'org-1' }), error);
    expect(commit.onFailed).not.toHaveBeenCalled();

    const commitJob = job('import.commit', { orgId: 'org-1', batchId: 'b-1' });
    await processor.onFailed(commitJob, error);
    expect(commit.onFailed).toHaveBeenCalledWith(commitJob, error);
  });
});
