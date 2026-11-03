import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { redactSnapshotNotes } from '../../src/lib/redact-pii';

// Recurrence guard: the git-tracked snapshot must already be in redacted form. If a writer
// persists raw pasted-email notes, this fails and prints only the JSON path, never the value.
describe('data/snapshots/portfolio.json free-text notes carry no third-party contact data', () => {
  it('redaction is a no-op on every notes field', () => {
    const raw = JSON.parse(readFileSync(resolve(__dirname, '../../data/snapshots/portfolio.json'), 'utf8')) as unknown;
    const offenders: string[] = [];
    let checked = 0;
    const walk = (node: unknown, path: string): void => {
      if (Array.isArray(node)) return node.forEach((v, i) => walk(v, `${path}[${i}]`));
      if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
          if (k === 'notes' && typeof v === 'string') {
            checked += 1;
            if (redactSnapshotNotes({ notes: v }).changed > 0) offenders.push(`${path}.notes`);
          } else walk(v, `${path}.${k}`);
        }
      }
    };
    walk(raw, '$');
    // A renamed key or a moved file must not turn this into a vacuous pass.
    expect(checked).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });
});
