import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sendEmail } from '../../server/brief/send';

const out = mkdtempSync(join(tmpdir(), 'brief-'));

describe('sendEmail', () => {
  beforeEach(() => { process.env.BRIEF_OUTBOX_DIR = out; });

  it('reports via "com" when the COM sender succeeds', async () => {
    const r = await sendEmail({ subject: 'S', html: '<p>x</p>' }, ['a@b.com'], { send: async () => true, outboxDir: out });
    expect(r.ok).toBe(true);
    expect(r.via).toBe('com');
  });

  it('falls back to the outbox + flags failure when COM fails', async () => {
    const r = await sendEmail({ subject: 'S', html: '<p>x</p>' }, ['a@b.com'], { send: async () => { throw new Error('com down'); }, outboxDir: out });
    expect(r.ok).toBe(false);
    expect(r.via).toBe('outbox');
    expect(readdirSync(out).some((f) => f.endsWith('.html'))).toBe(true);
  });
});
