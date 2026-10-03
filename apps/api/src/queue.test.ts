import { REVIEW_JOB_NAME, type ReviewJobData } from '@reviewlens/shared';
import { describe, expect, it, vi } from 'vitest';
import { createEnqueueReview, REVIEW_JOB_OPTIONS, type ReviewQueue } from './queue.js';

const job: ReviewJobData = {
  deliveryId: 'delivery-1',
  installationId: 42,
  repositoryId: 7,
  owner: 'octo',
  repo: 'hello',
  pullNumber: 3,
  headSha: 'a'.repeat(40),
  baseSha: 'b'.repeat(40),
};

function fakeQueue() {
  const add = vi.fn<ReviewQueue['add']>(async (_name, _data, opts) => ({ id: opts.jobId }));
  return { queue: { add }, add };
}

describe('createEnqueueReview', () => {
  it('adds a review job with retry options and a deterministic id', async () => {
    const { queue, add } = fakeQueue();
    const { jobId } = await createEnqueueReview(queue)(job);

    expect(jobId).toBe(`pr-7-3-${'a'.repeat(40)}`);
    expect(add).toHaveBeenCalledExactlyOnceWith(REVIEW_JOB_NAME, job, {
      ...REVIEW_JOB_OPTIONS,
      jobId,
    });
  });

  it('reuses the job id for redeliveries of the same head commit', async () => {
    const { queue, add } = fakeQueue();
    const enqueue = createEnqueueReview(queue);
    await enqueue(job);
    await enqueue({ ...job, deliveryId: 'delivery-2' });

    const ids = add.mock.calls.map((call) => call[2].jobId);
    expect(ids[0]).toBe(ids[1]);
  });

  it('uses a new job id when the PR gets a new head commit', async () => {
    const { queue } = fakeQueue();
    const enqueue = createEnqueueReview(queue);
    const first = await enqueue(job);
    const second = await enqueue({ ...job, headSha: 'c'.repeat(40) });
    expect(first.jobId).not.toBe(second.jobId);
  });

  it('times out when the queue never answers (Redis unreachable)', async () => {
    const queue: ReviewQueue = { add: () => new Promise(() => {}) };
    await expect(createEnqueueReview(queue, 20)(job)).rejects.toThrow('enqueue timed out');
  });

  it('propagates queue failures so GitHub sees a failed delivery', async () => {
    const queue: ReviewQueue = { add: () => Promise.reject(new Error('redis down')) };
    await expect(createEnqueueReview(queue)(job)).rejects.toThrow('redis down');
  });
});
