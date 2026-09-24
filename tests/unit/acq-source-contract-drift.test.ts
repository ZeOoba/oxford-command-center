// @vitest-environment node
// Every literal the server writes into acq_candidates.source must parse against the read-side
// Zod enum — PR #203 added a 'hubspot-pipeline' writer without widening AcqCandidateRow, and one
// HubSpot row 500'd GET /acq/intel and /acq/candidates (2026-09-23 review).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AcqCandidateRow } from '@contracts/acquisition';

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return tsFiles(p);
    return p.endsWith('.ts') ? [p] : [];
  });
}

describe('acq_candidates.source contract drift', () => {
  it('every source literal the server INSERTs parses against AcqCandidateRow.source', () => {
    const literals = new Set<string>();
    const re = /INSERT(?:\s+OR\s+IGNORE)?\s+INTO\s+acq_candidates[\s\S]*?VALUES\s*\(\s*\?\s*,\s*'([a-z-]+)'/g;
    for (const f of tsFiles('server')) {
      for (const m of readFileSync(f, 'utf8').matchAll(re)) literals.add(m[1]!);
    }
    expect(literals.size).toBeGreaterThan(0);
    for (const s of literals) {
      expect(AcqCandidateRow.shape.source.safeParse(s).success, `unparseable source literal: ${s}`).toBe(true);
    }
  });
});
