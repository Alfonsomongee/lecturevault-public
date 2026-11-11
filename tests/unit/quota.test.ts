import { describe, expect, it } from 'vitest';
import { quotaWait, RateGate } from '../../src/ai/quota.js';

// The body Gemini returns with a 429 (shape of the real API: QuotaFailure + RetryInfo)
const tooMany = (quotaId: string, retryDelay?: string) => JSON.stringify({
  error: {
    code: 429,
    status: 'RESOURCE_EXHAUSTED',
    message: 'You exceeded your current quota',
    details: [
      { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests', quotaId }] },
      ...(retryDelay ? [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay }] : []),
    ],
  },
});

describe('quotaWait', () => {
  it('waits what Gemini asks when the per-minute quota is hit', () => {
    expect(quotaWait(429, tooMany('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', '37s'))).toEqual({ kind: 'minute', ms: 37_000 });
    expect(quotaWait(429, tooMany('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', '2.5s'))).toEqual({ kind: 'minute', ms: 2_500 });
  });

  it('gives up at once when the daily quota is used up: retrying cannot help', () => {
    expect(quotaWait(429, tooMany('GenerateRequestsPerDayPerProjectPerModel-FreeTier', '20s'))).toEqual({ kind: 'day' });
  });

  it('uses Retry-After when the body says nothing, and a minute when nothing says anything', () => {
    expect(quotaWait(429, 'not json', '12')).toEqual({ kind: 'minute', ms: 12_000 });
    expect(quotaWait(429, '')).toEqual({ kind: 'minute', ms: 60_000 });
  });

  it('is not about quota for any other status', () => {
    expect(quotaWait(500, tooMany('X', '10s'))).toBeNull();
    expect(quotaWait(503, '')).toBeNull();
  });
});

describe('RateGate', () => {
  it('lets through up to N requests per minute and makes the next one wait', async () => {
    let now = 0;
    const waits: number[] = [];
    const gate = new RateGate(3, { now: () => now, sleep: async (ms) => { waits.push(ms); now += ms; } });
    for (let i = 0; i < 3; i++) await gate.take();
    expect(waits).toEqual([]);
    now = 10_000;
    await gate.take(); // the first of the three left the window at 60 s
    expect(waits).toEqual([50_000]);
  });

  it('can be switched off', async () => {
    const gate = new RateGate(0, { now: () => 0, sleep: async () => { throw new Error('should not wait'); } });
    for (let i = 0; i < 100; i++) await gate.take();
  });

  it('can be pushed back by a 429 (the server knows better)', async () => {
    let now = 0;
    const waits: number[] = [];
    const gate = new RateGate(10, { now: () => now, sleep: async (ms) => { waits.push(ms); now += ms; } });
    gate.pause(30_000);
    await gate.take();
    expect(waits).toEqual([30_000]);
  });
});
