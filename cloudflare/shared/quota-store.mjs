import schema from '../../src/quota-schema.js';

const { sanitizeQuotaSnapshot } = schema;
export const LATEST_KEY = 'quota:latest';
export const HISTORY_MS = 90 * 24 * 60 * 60_000;
const PREFIX = 'quota:sample:';
const key = at => PREFIX + String(Math.max(0, Math.round(at))).padStart(14, '0');

export async function saveQuota(storage, input, now = Date.now()) {
  const sample = sanitizeQuotaSnapshot(input);
  if (!sample?.capturedAt || !sample.accounts.length) return await storage.get(LATEST_KEY) || null;
  const latest = await storage.transaction(async tx => {
    const current = await tx.get(LATEST_KEY);
    if (current && current.capturedAt >= sample.capturedAt) return current;
    await tx.put({ [LATEST_KEY]: sample, [key(sample.capturedAt)]: sample });
    return sample;
  });
  const expired = await storage.list({ prefix: PREFIX, end: key(now - HISTORY_MS), limit: 1000 });
  if (expired.size) await storage.delete([...expired.keys()]);
  return latest;
}

export async function readQuotaHistory(storage, now = Date.now()) {
  const rows = await storage.list({ prefix: PREFIX, start: key(now - 24 * 60 * 60_000), reverse: true, limit: 144 });
  return [...rows.values()].map(sanitizeQuotaSnapshot).filter(Boolean);
}
