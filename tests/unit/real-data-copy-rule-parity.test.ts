// @vitest-environment node
//
// The push-time scan (scripts/prepush-confidential-scan.mjs isRealDataPath) and the gate
// (scripts/governance-check.ts checkRealDataUntracked) must agree on what is real data: the copy rule is
// written twice (one is plain .mjs run by the git hook, the other is TypeScript), so this proves the two
// copies give the same verdict on a probe set built from the manifest. Refute round 7.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { loadRealDataManifest, isRealDataPath } from '../../scripts/prepush-confidential-scan.mjs';
import { checkRealDataUntracked } from '../../scripts/governance-check';

const REPO = process.cwd();

describe('real-data copy rule: push-time scan and governance check agree', () => {
  it('gives the same verdict on generated copies, siblings and tracked files', () => {
    const m = loadRealDataManifest();
    const probes = new Set<string>();
    for (const f of m.files) {
      const slash = f.lastIndexOf('/');
      const dir = slash >= 0 ? f.slice(0, slash + 1) : '';
      const base = f.slice(slash + 1);
      const dot = base.lastIndexOf('.');
      const stem = dot > 0 ? base.slice(0, dot) : base;
      const ext = dot > 0 ? base.slice(dot) : '';
      for (const p of [
        f,
        f.toUpperCase(),
        f.replace(/\//g, '\\'),
        `${dir}${stem} - Copy${ext}`,
        `${dir}${stem} (3)${ext}`,
        `${dir}Copy of ${base}`,
        `${dir}${stem}_old${ext}`,
        `${dir}${stem}.test${ext}`,
        `${dir}${stem}x${ext}`,
        `${dir}my${stem}${ext}`,
        `${dir}golden_${base}`,
        `${dir}backup_${base}`,
        `${dir}old/${base}`,
        `${dir}${base}~`,
        `${dir.replace(/\/$/, '')}2/${base}`,
        `${dir.replace(/\/$/, '')} - Copy/${base}`,
        `fixtures/synthetic/${dir}${stem} (1)${ext}`,
      ]) {
        probes.add(p);
      }
    }
    for (const d of m.dirs) probes.add(`${d}x.json`).add(`${d.replace(/\/$/, '')}x/y.json`);
    for (const f of execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).split('\0').filter(Boolean)) probes.add(f);
    expect(probes.size).toBeGreaterThan(1000);
    const disagree = [...probes].filter((p) => isRealDataPath(p, m) === checkRealDataUntracked(REPO, [p]).pass);
    expect(disagree).toEqual([]);
  });
});
