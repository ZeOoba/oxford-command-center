import { afterEach, describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import {
  chunkText,
  isExcludedPath,
  isLikelyNonLease,
  matchesIndexFilters,
  maxFiles,
  maxChunksPerDoc,
  maxDepth,
  pathIncludeRe,
  includeDirs,
  reindexSafetyError,
  buildDocIndex,
  collectDocChunks,
  docStatus,
  type DocChunk,
  type Embedder,
  buildIndex,
  loadDiskIndex,
  docIndexPath,
  writeChunkPlan,
  embedMissing,
  indexCounts,
  queryIndex,
  extractXlsxText,
  ocrCacheDir,
  ocrCacheKey,
  ocrCachePathFor,
  readOcrText,
  listIndexableFiles,
  listIndexablePdfs,
  shapeFused,
} from '../../server/sources/documents';
import type { FusedRow } from '../../server/sources/doc-rank';

/**
 * Restore a process.env key to a previously-captured snapshot value. Assigning `process.env.X =
 * undefined` does NOT unset the var — Node coerces it to the literal STRING "undefined". When the var
 * was originally unset, that pollutes it for every later test; under shuffled order a later consumer
 * then reads the bogus value (e.g. includeDirs() treats "undefined" as a one-entry top-level allowlist
 * and prunes the whole corpus → 0 documents). Delete on undefined so an unset var goes back to truly
 * unset. Used at EVERY env-restore site below so no describe block can leak across test order.
 */
function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

describe('restoreEnv — env snapshot/restore must never write the string "undefined"', () => {
  const KEY = 'DOCUMENTS_RESTORE_PROBE';
  afterEach(() => {
    delete process.env[KEY];
  });
  it('deletes the key when restoring an originally-unset (undefined) snapshot', () => {
    delete process.env[KEY];
    const snapshot = process.env[KEY]; // a real, unset undefined
    process.env[KEY] = 'temp-value';
    restoreEnv(KEY, snapshot);
    expect(KEY in process.env).toBe(false); // truly unset — NOT the string "undefined"
    expect(process.env[KEY]).toBeUndefined();
  });
  it('restores a real prior string value verbatim', () => {
    process.env[KEY] = 'original';
    const snapshot = process.env[KEY];
    process.env[KEY] = 'temp-value';
    restoreEnv(KEY, snapshot);
    expect(process.env[KEY]).toBe('original');
  });
});

describe('chunkText', () => {
  it('returns a single chunk for short text and none for empty', () => {
    expect(chunkText('A short lease clause.')).toEqual(['A short lease clause.']);
    expect(chunkText('   ')).toEqual([]);
  });

  it('splits long text into multiple overlapping chunks', () => {
    const long = Array.from({ length: 60 }, (_, i) => `Section ${i}. ` + 'lorem ipsum dolor sit amet. ').join('\n\n');
    const chunks = chunkText(long, 400, 80);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 600)).toBe(true);
  });
});

describe('isExcludedPath — confidentiality / personal guard', () => {
  it('excludes personal/estate folders by default (case-insensitive)', () => {
    expect(isExcludedPath('Estate Planning and Trust Documents/trust.pdf')).toBe(true);
    expect(isExcludedPath('Gabriel Documents/personal.pdf')).toBe(true);
    expect(isExcludedPath('GDG Properties EG Properties and personal info/x.pdf')).toBe(true);
  });
  it('excludes confidential-deal patterns supplied via DOCUMENTS_EXCLUDE (injected here, never hardcoded)', () => {
    // The real codename lives only in the gitignored env var; the guard regex-matches it.
    const patterns = [/secret-codename/i];
    expect(isExcludedPath('deals/Secret-Codename/psa.pdf', patterns)).toBe(true);
    expect(isExcludedPath('deals/Secret-Codename DD Items/phase-ii.pdf', patterns)).toBe(true);
  });
  it('allows ordinary property lease/PSA paths', () => {
    expect(isExcludedPath('1100 Rarig/Eurosort Lease.pdf')).toBe(false);
    expect(isExcludedPath('29000 Information Lane/Shore United PSA.pdf')).toBe(false);
  });
  it('excludes the GDG/CRG estate folder and the Pictures tree (hardened)', () => {
    expect(isExcludedPath('GDG Estate 12-2022 and CRG Estate 03-2023/trust.pdf')).toBe(true);
    expect(isExcludedPath('Pictures/Business Pics/6860 Distribution Drive.JPG')).toBe(true);
    expect(isExcludedPath('Pictures/Lucy Camp 2003/photo.jpg')).toBe(true);
  });
  it('does NOT over-match legitimate "real estate" business paths', () => {
    expect(isExcludedPath('6300 Sherriff Road/2009-2011 real estate tax appeal results.pdf')).toBe(false);
    expect(isExcludedPath('Investment Candidates -- 2015/Eastside Plaza NOI CALC.xlsx')).toBe(false);
  });
  it('excludes personal/family estate docs filed inside business folders (2026-06-06 audit)', () => {
    expect(isExcludedPath('Muirkirk/GDG Revocable Trust.pdf')).toBe(true);
    expect(isExcludedPath('Loans External/Loan Symetra/Tax Return -- Eric Goldberg Family Irrevocable Trust 2024.pdf')).toBe(true);
    expect(isExcludedPath('Corporate and Settlement and Legal Documents/ATRCI Sale Docs/Private Annuity Agreements between Trust LLCs.pdf')).toBe(true);
    expect(isExcludedPath('Eulogy -- CRG.docx')).toBe(true);
    expect(isExcludedPath('Muirkirk 2013 Refinancing/GDG 1031 Deposit w IPX 6-19-13.pdf')).toBe(true);
    expect(isExcludedPath('Corporate and Settlement and Legal Documents/Goldberg Annuity, LLC Corp Documents/note.pdf')).toBe(true);
  });
  it('excludes raw parcel-screening lead dumps (enumerate confidential/denylisted parcels)', () => {
    expect(isExcludedPath('Investment Candidates -- 2026/20260605_Columbus-Motivated-Leads_v01.xlsx')).toBe(true);
    expect(isExcludedPath('Investment Candidates -- 2026/20260604_Columbus-Parcel-Screen_Pilot_v02.xlsx')).toBe(true);
  });
  it('excludes business instruments that name the family trust as a party (audit stragglers)', () => {
    expect(isExcludedPath('330 140 Village Avenue/Promissory note FVC -- Goldberg Trust.pdf')).toBe(true);
    expect(isExcludedPath('Promissory Notes/Promissory Note Assignment -- 5600 Sunnyside to EG & Lynn Abrams trust 10-2025.pdf')).toBe(true);
    expect(isExcludedPath('Corporate and Settlement and Legal Documents/Eric Goldberg Family, LLC Corp Documents/Tax ID Number (E-I-N) -- Eric I Goldberg Fam Trust for Muirkirk ownership.pdf')).toBe(true);
  });
  it('does NOT exclude business look-alikes (commercial deed of trust, family LLC, tenant trust)', () => {
    expect(isExcludedPath('2203-2207 Northwood/Deed of Trust 9.19.2024 Clean -- 2203 Northwood.docx')).toBe(false);
    expect(isExcludedPath('Corporate and Settlement and Legal Documents/Eric Goldberg Family, LLC Corp Documents/Deed of Trust -- 55 New Plant.pdf')).toBe(false);
    expect(isExcludedPath('Loans External/Loan 5600/Certificates of Insurance -- Restoration Trust Church 02-2025.pdf')).toBe(false);
  });
});

// OS-agnostic Leases-folder pattern: matcher normalizes `\` → `/`, so only `/` is needed here.
const LEASES_RE = /(^|\/)Leases(\/)/i;

describe('isExcludedPath — W-9 / taxpayer-ID forms (2026-10-14: 31 W-9 PDFs were found in the live index)', () => {
  it('excludes W-9 forms however they are filed or named (folder or file, W9 / W-9 / W9s)', () => {
    for (const p of [
      'Business\\W9s\\Acme Vendor.pdf', //                                  the dedicated folder
      'Business\\1851 South Club Solar LLC\\W9 -- 1851 South Club Solar LLC.pdf',
      'Business\\1900 North Broadway\\W9 signed2024 Repair + Paint 1900.pdf',
      'Business\\3034 Westerville\\W9-5242 Angola Road LLC.pdf', //          hyphen after W9
      'Business\\Corporate and Settlement and Legal Documents\\2203 Northwood, LLC\\W-9 -- 2203 Northwood LLC (OCR).pdf',
      'Business\\Oxford Realty Advisors\\Oxford Realty W9 Signed 9-13-10.pdf', // mid-name
      'Business\\Oxford Realty Advisors\\W9_Signed -- EGFLLC.pdf', //        underscore after W9
      'Business\\X\\Form W-9.pdf', //                                        end of name before extension
      'Business\\X\\w9.pdf',
      // Adversarial review (2026-10-14): how W-9s are actually downloaded, duplicated and typed.
      'Business\\X\\fw9.pdf', //                                             the IRS download filename
      'Business\\X\\fw9 (1).pdf',
      'Business\\X\\Acme W-9(1).pdf', //                                     browser duplicate suffix
      'Business\\X\\W9(2).pdf',
      'Business\\X\\W 9 Acme.pdf', //                                        space / underscore / en dash between W and 9
      'Business\\X\\W_9 Acme.pdf',
      'Business\\X\\W–9 Acme.pdf',
      'Business\\X\\w9form.pdf',
      'Business\\X\\Acme(W9).pdf', //                                        bracketed / dotted / possessive
      'Business\\X\\[W9] Acme.pdf',
      'Business\\X\\Acme.W9.pdf',
      "Business\\X\\Acme W9's.pdf",
      'Business\\X\\Acme W9signed.pdf',
      'Business\\X\\Tax payer ID.pdf',
      // Round-2 review: 17 in-scope PDFs carry the same identifier under "Tax ID…" names.
      'Business\\X\\Tax ID Number.pdf',
      'Business\\X\\Tax Identification Letter.pdf',
      'Business\\X\\Tax-ID.pdf',
      'Business\\X\\FederalTaxIdentification.pdf',
    ]) {
      expect(isExcludedPath(p), p).toBe(true);
    }
  });

  it('excludes taxpayer-ID / taxpayer-profile documents', () => {
    expect(isExcludedPath('Business\\Investment Candidates -- 2026\\outputs\\ORA_Taxpayer-Profile_v01.md')).toBe(true);
    expect(isExcludedPath('Business\\X\\Taxpayer ID Certification.pdf')).toBe(true);
  });

  it('does NOT exclude business look-alikes (1099 reports, "Window9", ordinary leases, "W9" inside a word)', () => {
    for (const p of [
      'Business\\55 New Plant Court\\1099 Eurosort 2025 -- 55 New Plant Ct.pdf',
      'Business\\X\\Window9 Report.pdf',
      'Business\\55 New Plant Court\\Lease Eurosort -- 55 New Plant Court 10-2022.pdf',
      'Business\\Master Lease Database\\15 - 55 New Plant Court (Owings Mills MD)\\Lease.pdf',
      'Business\\X\\Lease 109 Main St.pdf',
      'Business\\X\\Rent Roll 2019.pdf',
      'Business\\X\\W91 Report.pdf', //                                      a digit after W9 is not a W-9
      'Business\\123 W 9th St\\Lease.pdf', //                                an address, not a form
      'Business\\X\\500 W 9 Mile Rd Lease.pdf',
      'Business\\X\\Syntax ID Guide.pdf', //                                 "…tax ID" inside a word
      'Business\\X\\Lease Tax Bill 2025.pdf',
      'Business\\X\\Tax Identifier Parcel Map.pdf', //                       a parcel "identifier" is not a taxpayer ID
    ]) {
      expect(isExcludedPath(p), p).toBe(false);
    }
  });
});

describe('matchesIndexFilters — extension + optional path-include filter', () => {
  it('supports pdf/txt/md/docx/xlsx/csv/tsv, skipping legacy .doc and binary .pptx', () => {
    expect(matchesIndexFilters('PropA/Leases/x.pdf', null)).toBe(true);
    expect(matchesIndexFilters('PropA/Leases/x.txt', null)).toBe(true);
    expect(matchesIndexFilters('PropA/Leases/x.docx', null)).toBe(true);
    expect(matchesIndexFilters('PropA/Leases/x.xlsx', null)).toBe(true);
    expect(matchesIndexFilters('PropA/Leases/x.csv', null)).toBe(true);
    expect(matchesIndexFilters('PropA/Leases/x.tsv', null)).toBe(true);
    expect(matchesIndexFilters('PropA/Leases/x.doc', null)).toBe(false); // legacy binary — unsupported
    expect(matchesIndexFilters('PropA/Leases/x.pptx', null)).toBe(false); // not yet supported
  });
  it('honors a Leases-only include filter (path must contain a Leases directory segment)', () => {
    expect(matchesIndexFilters('9050 Red Branch Rd/Leases/lease.pdf', LEASES_RE)).toBe(true);
    expect(matchesIndexFilters('9050 Red Branch Rd/Other/note.pdf', LEASES_RE)).toBe(false);
    expect(matchesIndexFilters('9050 Red Branch Rd/Leases.pdf', LEASES_RE)).toBe(false); // file, not a Leases folder
  });
  it('matches Windows backslash paths via separator normalization', () => {
    expect(matchesIndexFilters('29000 Information Lane\\Leases\\Shore United.pdf', LEASES_RE)).toBe(true);
    expect(matchesIndexFilters('29000 Information Lane\\Other\\x.pdf', LEASES_RE)).toBe(false);
  });
  it('drops non-lease docs even under a Leases folder', () => {
    expect(matchesIndexFilters('Sepich Portfolio/Leases/2019 Sepich I- P&L.pdf', LEASES_RE)).toBe(false);
    expect(matchesIndexFilters('Sepich Portfolio/Leases/Rent Roll -- Dec 2020.pdf', LEASES_RE)).toBe(false);
    expect(matchesIndexFilters('1100 Rarig/Leases/Eurosort Lease.pdf', LEASES_RE)).toBe(true);
  });
  it('keeps financials/rent-rolls when the non-lease filter is OFF (general OneDrive mode)', () => {
    const pnl = '6300 Sherriff Road/2018 6300 Sheriff Road LLC P&L.pdf';
    expect(matchesIndexFilters(pnl, null, true)).toBe(false); // lease mode drops it
    expect(matchesIndexFilters(pnl, null, false)).toBe(true); // general mode keeps it
  });
});

describe('isLikelyNonLease — corpus tightening (drops financials/rent-rolls/disclosures)', () => {
  it('drops obvious non-lease docs by filename', () => {
    expect(isLikelyNonLease('Sepich Portfolio/Leases/Financial Statements 2019/2019 Sepich I- P&L.pdf')).toBe(true);
    expect(isLikelyNonLease('Leases All properties/Leases/Rent Roll -- Dec 2020.pdf')).toBe(true);
    expect(isLikelyNonLease('Leases All properties/Leases/Current Rent Rolls 11.9.20.xlsb.pdf')).toBe(true);
    expect(isLikelyNonLease('Sepich Portfolio/Leases/2012 Zettler Agency Disclosure.pdf')).toBe(true);
  });
  it('keeps real leases and legitimate lease components', () => {
    expect(isLikelyNonLease('1100 Rarig/Leases/Eurosort Lease.pdf')).toBe(false);
    expect(isLikelyNonLease('9050 Red Branch Rd/Leases/Exhibit Package -- Unit A Soccer Plant Lease 01-2025.pdf')).toBe(false);
    expect(isLikelyNonLease('1900 North Broadway/Leases/Commencement Date Certificate -- Exhibit D Baltimore Dialysis Lease.pdf')).toBe(false);
  });
  it('matches via separator normalization (Windows backslash paths)', () => {
    expect(isLikelyNonLease('Sepich Portfolio\\Leases\\Rent Roll -- Dec 2020.pdf')).toBe(true);
  });
});

describe('env knobs — pathIncludeRe + maxFiles', () => {
  const prev = { inc: process.env.DOCUMENTS_PATH_INCLUDE, max: process.env.DOCUMENTS_MAX_FILES };
  afterEach(() => {
    restoreEnv('DOCUMENTS_PATH_INCLUDE', prev.inc);
    restoreEnv('DOCUMENTS_MAX_FILES', prev.max);
  });
  it('pathIncludeRe is null when unset and a regex when set', () => {
    delete process.env.DOCUMENTS_PATH_INCLUDE;
    expect(pathIncludeRe()).toBeNull();
    process.env.DOCUMENTS_PATH_INCLUDE = '(^|/)Leases(/)';
    expect(pathIncludeRe()?.test('A/Leases/x.pdf')).toBe(true);
  });
  it('maxFiles defaults to 2000 and honors a valid override', () => {
    delete process.env.DOCUMENTS_MAX_FILES;
    expect(maxFiles()).toBe(2000);
    process.env.DOCUMENTS_MAX_FILES = '50';
    expect(maxFiles()).toBe(50);
    process.env.DOCUMENTS_MAX_FILES = 'nonsense';
    expect(maxFiles()).toBe(2000);
  });
  it('maxDepth defaults to 6 and honors a valid override; ignores nonsense', () => {
    const p = process.env.DOCUMENTS_MAX_DEPTH;
    delete process.env.DOCUMENTS_MAX_DEPTH;
    expect(maxDepth()).toBe(6);
    process.env.DOCUMENTS_MAX_DEPTH = '9';
    expect(maxDepth()).toBe(9);
    process.env.DOCUMENTS_MAX_DEPTH = 'nonsense';
    expect(maxDepth()).toBe(6);
    restoreEnv('DOCUMENTS_MAX_DEPTH', p);
  });
});

describe('maxChunksPerDoc — per-document chunk cap', () => {
  const prev = process.env.DOCUMENTS_MAX_CHUNKS_PER_DOC;
  afterEach(() => {
    restoreEnv('DOCUMENTS_MAX_CHUNKS_PER_DOC', prev);
  });
  // 120 (not 25, not 80): the Eurosort executed lease OCRs to ~129K chars = ~87 chunks and its "Option to
  // Renew" clause (§43) sits at 90% of the text — a 25-chunk cap kept ~14 pages and an 80-chunk cap still
  // cut the clause off (measured 2026-10-14). 120 chunks ≈ 165K chars.
  it('defaults to 120 and honors a valid override; ignores nonsense', () => {
    delete process.env.DOCUMENTS_MAX_CHUNKS_PER_DOC;
    expect(maxChunksPerDoc()).toBe(120);
    process.env.DOCUMENTS_MAX_CHUNKS_PER_DOC = '8';
    expect(maxChunksPerDoc()).toBe(8);
    process.env.DOCUMENTS_MAX_CHUNKS_PER_DOC = 'nonsense';
    expect(maxChunksPerDoc()).toBe(120);
  });
});

describe('OCR cache — cache-aware PDF extraction (temp corpus)', () => {
  const prev = {
    dir: process.env.DOCUMENTS_DIR,
    inc: process.env.DOCUMENTS_PATH_INCLUDE,
    allow: process.env.DOCUMENTS_INCLUDE_DIRS,
    cache: process.env.DOCUMENTS_OCR_CACHE_DIR,
    drop: process.env.DOCUMENTS_DROP_NONLEASE,
  };
  afterEach(() => {
    restoreEnv('DOCUMENTS_DIR', prev.dir);
    restoreEnv('DOCUMENTS_PATH_INCLUDE', prev.inc);
    restoreEnv('DOCUMENTS_INCLUDE_DIRS', prev.allow);
    restoreEnv('DOCUMENTS_OCR_CACHE_DIR', prev.cache);
    restoreEnv('DOCUMENTS_DROP_NONLEASE', prev.drop);
  });

  // A "scanned" PDF the text extractor cannot read (not a real PDF → pdf-parse throws → '' today), which
  // is exactly the case the OCR cache must rescue. Returns { root, cacheDir, scan, estate }.
  function setup(): { root: string; cacheDir: string; scan: string; estate: string } {
    const root = mkdtempSync(join(tmpdir(), 'ocrcorp-'));
    const cacheDir = mkdtempSync(join(tmpdir(), 'ocrcache-'));
    mkdirSync(join(root, 'PropA', 'Leases'), { recursive: true });
    mkdirSync(join(root, 'Estate Planning', 'Leases'), { recursive: true });
    const scan = join(root, 'PropA', 'Leases', 'Lease Scan.pdf');
    const estate = join(root, 'Estate Planning', 'Leases', 'Trust Scan.pdf');
    writeFileSync(scan, '%PDF-1.4 not really a pdf');
    writeFileSync(estate, '%PDF-1.4 not really a pdf either');
    process.env.DOCUMENTS_DIR = root;
    process.env.DOCUMENTS_OCR_CACHE_DIR = cacheDir;
    delete process.env.DOCUMENTS_PATH_INCLUDE;
    delete process.env.DOCUMENTS_INCLUDE_DIRS;
    delete process.env.DOCUMENTS_DROP_NONLEASE;
    return { root, cacheDir, scan, estate };
  }
  function putOcr(file: string, text: string): void {
    writeFileSync(ocrCachePathFor(file)!, text);
  }

  it('ocrCacheDir honors DOCUMENTS_OCR_CACHE_DIR and has an ora-doc-index default', () => {
    process.env.DOCUMENTS_OCR_CACHE_DIR = 'C:\\somewhere\\ocr';
    expect(ocrCacheDir()).toBe('C:\\somewhere\\ocr');
    delete process.env.DOCUMENTS_OCR_CACHE_DIR;
    expect(ocrCacheDir().replace(/\\/g, '/')).toMatch(/ora-doc-index\/ocr-cache$/);
  });

  it('ocrCacheKey is stable, and changes when the file changes (size/mtime)', () => {
    const { root, cacheDir, scan } = setup();
    try {
      const k1 = ocrCacheKey(scan);
      expect(k1).toMatch(/^[0-9a-f]{40}$/);
      expect(ocrCacheKey(scan)).toBe(k1);
      writeFileSync(scan, '%PDF-1.4 now a different, longer scanned body');
      expect(ocrCacheKey(scan)).not.toBe(k1);
      expect(ocrCacheKey(join(root, 'nope.pdf'))).toBeNull(); // missing file → no key, never throws
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it('readOcrText returns null on a miss and the cached text on a hit', () => {
    const { root, cacheDir, scan } = setup();
    try {
      expect(readOcrText(scan)).toBeNull();
      putOcr(scan, 'cached ocr text');
      expect(readOcrText(scan)).toBe('cached ocr text');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it('indexes an unreadable scanned PDF from its OCR cache entry', async () => {
    const { root, cacheDir, scan } = setup();
    try {
      putOcr(scan, 'Tenant shall have one option to renew this lease for five years.');
      const { chunks, docs } = await collectDocChunks();
      expect(docs.map((d) => d.name.replace(/\\/g, '/'))).toEqual(['PropA/Leases/Lease Scan.pdf']);
      expect(chunks.some((c) => c.text.includes('option to renew'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it('without a cache entry the unreadable PDF is still skipped (behavior unchanged)', async () => {
    const { root, cacheDir } = setup();
    try {
      const { docs } = await collectDocChunks();
      expect(docs.length).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it('ignores a STALE cache entry after the PDF changes (key no longer matches)', async () => {
    const { root, cacheDir, scan } = setup();
    try {
      putOcr(scan, 'old ocr text from the previous version of the file');
      writeFileSync(scan, '%PDF-1.4 replaced by a newer scan with a different size');
      const { docs } = await collectDocChunks();
      expect(docs.length).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it('a cache entry NEVER resurrects a path outside the DOCUMENTS_INCLUDE_DIRS allowlist', async () => {
    const { root, cacheDir } = setup();
    try {
      mkdirSync(join(root, 'Unlisted Folder', 'Leases'), { recursive: true });
      mkdirSync(join(root, 'Listed Folder', 'Leases'), { recursive: true });
      const unlisted = join(root, 'Unlisted Folder', 'Leases', 'Scan.pdf');
      const listed = join(root, 'Listed Folder', 'Leases', 'Scan.pdf');
      writeFileSync(unlisted, '%PDF-1.4 not really a pdf');
      writeFileSync(listed, '%PDF-1.4 not really a pdf');
      putOcr(unlisted, 'text from a folder that is not allowlisted');
      putOcr(listed, 'text from the allowlisted folder');
      process.env.DOCUMENTS_INCLUDE_DIRS = 'Listed Folder';
      const { docs } = await collectDocChunks();
      expect(docs.map((d) => d.name.replace(/\\/g, '/'))).toEqual(['Listed Folder/Leases/Scan.pdf']);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it('listIndexablePdfs skips PDFs over the indexer size cap (they are never read, so OCR would be wasted)', () => {
    const prevMb = process.env.DOCUMENTS_MAX_FILE_MB;
    const { root, cacheDir, scan } = setup();
    try {
      writeFileSync(scan, Buffer.alloc(4096, 1)); // 4 KB "scan"
      process.env.DOCUMENTS_MAX_FILE_MB = '0.001'; // ~1 KB cap
      expect(listIndexablePdfs()).toEqual([]);
      process.env.DOCUMENTS_MAX_FILE_MB = '25';
      expect(listIndexablePdfs().map((p) => p.path)).toEqual([scan]);
    } finally {
      restoreEnv('DOCUMENTS_MAX_FILE_MB', prevMb);
      rmSync(root, { recursive: true, force: true });
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it('a cache entry NEVER resurrects an excluded path (exclusion runs before extraction)', async () => {
    const { root, cacheDir, estate } = setup();
    try {
      putOcr(estate, 'confidential estate trust text that must never be indexed');
      const { docs, chunks } = await collectDocChunks();
      expect(docs.length).toBe(0);
      expect(chunks.length).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it('listIndexableFiles applies the indexer exclusions + filters; listIndexablePdfs adds keys and cache state', () => {
    const { root, cacheDir, scan, estate } = setup();
    try {
      writeFileSync(join(root, 'PropA', 'Leases', 'notes.txt'), 'plain text lease note');
      const { files } = listIndexableFiles();
      const rel = files.map((f) => f.slice(root.length).replace(/^[\\/]+/, '').replace(/\\/g, '/')).sort();
      expect(rel).toEqual(['PropA/Leases/Lease Scan.pdf', 'PropA/Leases/notes.txt']);
      expect(files.includes(estate)).toBe(false);

      putOcr(scan, 'cached');
      const pdfs = listIndexablePdfs();
      expect(pdfs.length).toBe(1); // PDFs only; the estate PDF is excluded upstream
      expect(pdfs[0]!.path).toBe(scan);
      expect(pdfs[0]!.rel.replace(/\\/g, '/')).toBe('PropA/Leases/Lease Scan.pdf');
      expect(pdfs[0]!.key).toBe(ocrCacheKey(scan));
      expect(pdfs[0]!.cached).toBe(true);
      expect(pdfs[0]!.size).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});

describe('buildDocIndex — Leases-only include filter + exclusion pruning (temp corpus)', () => {
  const prev = {
    dir: process.env.DOCUMENTS_DIR,
    inc: process.env.DOCUMENTS_PATH_INCLUDE,
    allow: process.env.DOCUMENTS_INCLUDE_DIRS,
  };
  afterEach(() => {
    restoreEnv('DOCUMENTS_DIR', prev.dir);
    restoreEnv('DOCUMENTS_PATH_INCLUDE', prev.inc);
    restoreEnv('DOCUMENTS_INCLUDE_DIRS', prev.allow);
  });

  // Build the canonical 3-folder temp corpus (one indexable lease under PropA/Leases) and point the
  // indexer at it under a Leases-only path filter. Establishes EVERY env precondition the assertions
  // depend on — including clearing any top-level DOCUMENTS_INCLUDE_DIRS allowlist — so the test is
  // self-contained under any (shuffled) test order. Returns the temp root for cleanup.
  function setupLeasesCorpus(): string {
    const root = mkdtempSync(join(tmpdir(), 'docidx-'));
    mkdirSync(join(root, 'PropA', 'Leases'), { recursive: true });
    mkdirSync(join(root, 'PropB', 'Other'), { recursive: true });
    mkdirSync(join(root, 'Estate Planning', 'Leases'), { recursive: true });
    writeFileSync(join(root, 'PropA', 'Leases', 'lease.txt'), 'Tenant has a right of first refusal to renew the premises.');
    writeFileSync(join(root, 'PropB', 'Other', 'note.txt'), 'miscellaneous non-lease document');
    writeFileSync(join(root, 'Estate Planning', 'Leases', 'trust.txt'), 'confidential estate document');
    process.env.DOCUMENTS_DIR = root;
    process.env.DOCUMENTS_PATH_INCLUDE = '(^|/)Leases(/)';
    delete process.env.DOCUMENTS_INCLUDE_DIRS; // precondition: no top-level allowlist scoping
    return root;
  }

  it('indexes ONLY files under Leases folders, skipping other + excluded (estate) dirs', async () => {
    const root = setupLeasesCorpus();
    try {
      await buildDocIndex(fakeEmbedder);
      const s = await docStatus();

      expect(s.documents).toBe(1); // only PropA/Leases/lease.txt
      expect(s.docs[0]!.name.replace(/\\/g, '/')).toBe('PropA/Leases/lease.txt');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('is order-independent: a leaked DOCUMENTS_INCLUDE_DIRS="undefined" does not blank the corpus', async () => {
    // Reproduces the exact residue a prior block leaves via `process.env.X = undefined`. The
    // self-contained setup must neutralize it; before the env-hygiene fix this indexed 0 documents.
    process.env.DOCUMENTS_INCLUDE_DIRS = 'undefined';
    const root = setupLeasesCorpus();
    try {
      await buildDocIndex(fakeEmbedder);
      const s = await docStatus();
      expect(s.documents).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('collectDocChunks — list+extract+chunk with per-doc cap', () => {
  const prev = {
    dir: process.env.DOCUMENTS_DIR,
    inc: process.env.DOCUMENTS_PATH_INCLUDE,
    cap: process.env.DOCUMENTS_MAX_CHUNKS_PER_DOC,
    allow: process.env.DOCUMENTS_INCLUDE_DIRS,
    drop: process.env.DOCUMENTS_DROP_NONLEASE,
  };
  afterEach(() => {
    restoreEnv('DOCUMENTS_DIR', prev.dir);
    restoreEnv('DOCUMENTS_PATH_INCLUDE', prev.inc);
    restoreEnv('DOCUMENTS_MAX_CHUNKS_PER_DOC', prev.cap);
    restoreEnv('DOCUMENTS_INCLUDE_DIRS', prev.allow);
    restoreEnv('DOCUMENTS_DROP_NONLEASE', prev.drop);
  });
  it('caps chunks per document and skips non-lease + excluded files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'collect-'));
    try {
      mkdirSync(join(root, 'PropA', 'Leases'), { recursive: true });
      // Long lease text → many chunks before the cap.
      const long = Array.from({ length: 80 }, (_, i) => `Section ${i}. ` + 'lorem ipsum dolor sit amet renew. '.repeat(4)).join('\n\n');
      writeFileSync(join(root, 'PropA', 'Leases', 'big-lease.txt'), long);
      writeFileSync(join(root, 'PropA', 'Leases', 'Rent Roll -- Dec 2020.txt'), 'rent roll table'); // non-lease → skipped

      process.env.DOCUMENTS_DIR = root;
      process.env.DOCUMENTS_PATH_INCLUDE = '(^|/)Leases(/)';
      process.env.DOCUMENTS_MAX_CHUNKS_PER_DOC = '3';
      delete process.env.DOCUMENTS_INCLUDE_DIRS; // precondition: no top-level allowlist scoping
      delete process.env.DOCUMENTS_DROP_NONLEASE; // precondition: drop-non-lease ON (default) → rent roll skipped

      const { chunks, docs } = await collectDocChunks();
      expect(docs.length).toBe(1); // rent roll skipped
      expect(docs[0]!.chunks).toBe(3); // capped
      expect(chunks.length).toBe(3);
      expect(chunks.every((c) => c.docName.replace(/\\/g, '/') === 'PropA/Leases/big-lease.txt')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('DOCUMENTS_INCLUDE_DIRS — fail-closed top-level allowlist', () => {
  const prev = {
    dir: process.env.DOCUMENTS_DIR,
    inc: process.env.DOCUMENTS_PATH_INCLUDE,
    allow: process.env.DOCUMENTS_INCLUDE_DIRS,
    drop: process.env.DOCUMENTS_DROP_NONLEASE,
  };
  afterEach(() => {
    restoreEnv('DOCUMENTS_DIR', prev.dir);
    restoreEnv('DOCUMENTS_PATH_INCLUDE', prev.inc);
    restoreEnv('DOCUMENTS_INCLUDE_DIRS', prev.allow);
    restoreEnv('DOCUMENTS_DROP_NONLEASE', prev.drop);
  });
  it('indexes ONLY allowlisted top-level folders, skipping unlisted + personal', async () => {
    const root = mkdtempSync(join(tmpdir(), 'allow-'));
    try {
      mkdirSync(join(root, '6300 Sherriff Road'), { recursive: true });
      mkdirSync(join(root, 'Estate Planning and Trust Documents'), { recursive: true });
      mkdirSync(join(root, 'Pictures'), { recursive: true });
      writeFileSync(join(root, '6300 Sherriff Road', 'lease.txt'), 'Tenant renewal option clause text.');
      writeFileSync(join(root, 'Estate Planning and Trust Documents', 'will.txt'), 'last will and testament');
      writeFileSync(join(root, 'Pictures', 'note.txt'), 'family photo caption');

      process.env.DOCUMENTS_DIR = root;
      delete process.env.DOCUMENTS_PATH_INCLUDE;
      process.env.DOCUMENTS_DROP_NONLEASE = '0';
      process.env.DOCUMENTS_INCLUDE_DIRS = '6300 Sherriff Road';

      const { docs } = await collectDocChunks();
      expect(docs.length).toBe(1);
      expect(docs[0]!.name.replace(/\\/g, '/')).toBe('6300 Sherriff Road/lease.txt');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('treats a top-level "Business" folder as transparent to the allowlist, without opening up other unlisted root dirs', async () => {
    // Regression test for the 2026-07-17 OneDrive Business/Personal split: DOCUMENTS_DIR stays at
    // OneDrive root, but most allowlisted folders now live one level deeper under Business\. An
    // allowlisted folder that stayed at root (like the real "Muirkirk 2013 Refinancing") must still
    // resolve too — this is not a DOCUMENTS_DIR repoint, it's a transparent pass-through.
    const root = mkdtempSync(join(tmpdir(), 'passthrough-'));
    try {
      mkdirSync(join(root, 'Business', '6300 Sherriff Road'), { recursive: true });
      mkdirSync(join(root, 'Business', 'Unlisted Folder'), { recursive: true });
      mkdirSync(join(root, 'Muirkirk 2013 Refinancing'), { recursive: true });
      mkdirSync(join(root, 'Personal'), { recursive: true });
      writeFileSync(join(root, 'Business', '6300 Sherriff Road', 'lease.txt'), 'Tenant renewal option clause text.');
      writeFileSync(join(root, 'Business', 'Unlisted Folder', 'x.txt'), 'should never be indexed');
      writeFileSync(join(root, 'Muirkirk 2013 Refinancing', 'doc.txt'), 'refinancing note text.');
      writeFileSync(join(root, 'Personal', 'y.txt'), 'should never be indexed');

      process.env.DOCUMENTS_DIR = root;
      delete process.env.DOCUMENTS_PATH_INCLUDE;
      process.env.DOCUMENTS_DROP_NONLEASE = '0';
      process.env.DOCUMENTS_INCLUDE_DIRS = '6300 Sherriff Road|Muirkirk 2013 Refinancing';

      const { docs } = await collectDocChunks();
      const names = docs.map((d) => d.name.replace(/\\/g, '/')).sort();
      expect(names).toEqual(['Business/6300 Sherriff Road/lease.txt', 'Muirkirk 2013 Refinancing/doc.txt']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fail-closed: a loose file at the effective top level is never indexed, even when it matches a supported extension', async () => {
    // A loose file directly at DOCUMENTS_DIR (or directly under a passthrough dir like Business\,
    // which is walked at the same effective depth) is never itself an allowlisted directory, so it
    // must be excluded outright — closing the gap where matchesIndexFilters alone (extension +
    // optional DOCUMENTS_PATH_INCLUDE) let such files through regardless of DOCUMENTS_INCLUDE_DIRS.
    const root = mkdtempSync(join(tmpdir(), 'root-file-gate-'));
    try {
      mkdirSync(join(root, '6300 Sherriff Road'), { recursive: true });
      mkdirSync(join(root, 'Business', '6300 Sherriff Road'), { recursive: true });
      writeFileSync(join(root, '6300 Sherriff Road', 'lease.txt'), 'Tenant renewal option clause text.');
      writeFileSync(join(root, 'Business', '6300 Sherriff Road', 'lease2.txt'), 'Another lease clause.');
      writeFileSync(join(root, 'Complete POF.pdf'.replace('.pdf', '.txt')), 'loose root-level file — must never be indexed');
      writeFileSync(join(root, 'Business', 'Asphalt cost doc.txt'), 'loose file directly under Business\\ — must never be indexed');

      process.env.DOCUMENTS_DIR = root;
      delete process.env.DOCUMENTS_PATH_INCLUDE;
      process.env.DOCUMENTS_DROP_NONLEASE = '0';
      process.env.DOCUMENTS_INCLUDE_DIRS = '6300 Sherriff Road';

      const { docs } = await collectDocChunks();
      const names = docs.map((d) => d.name.replace(/\\/g, '/')).sort();
      expect(names).toEqual(['6300 Sherriff Road/lease.txt', 'Business/6300 Sherriff Road/lease2.txt']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('includeDirs — delimiter robust to comma-containing folder names', () => {
  const prev = process.env.DOCUMENTS_INCLUDE_DIRS;
  afterEach(() => {
    restoreEnv('DOCUMENTS_INCLUDE_DIRS', prev);
  });
  it('splits on | so folder names with commas survive as single entries', () => {
    process.env.DOCUMENTS_INCLUDE_DIRS = '3883 Livingston, LLC|9620 State 350, LLC|6300 Sherriff Road';
    const dirs = includeDirs();
    expect(dirs?.size).toBe(3);
    expect(dirs?.has('3883 livingston, llc')).toBe(true);
    expect(dirs?.has('9620 state 350, llc')).toBe(true);
    expect(dirs?.has('6300 sherriff road')).toBe(true);
  });
  it('is null when unset', () => {
    delete process.env.DOCUMENTS_INCLUDE_DIRS;
    expect(includeDirs()).toBeNull();
  });
});

describe('reindexSafetyError — fail-closed pre-reindex confidentiality guard', () => {
  it('passes when DOCUMENTS_EXCLUDE and the DOCUMENTS_INCLUDE_DIRS allowlist are both set', () => {
    expect(reindexSafetyError({ DOCUMENTS_EXCLUDE: 'zzdemo', DOCUMENTS_INCLUDE_DIRS: 'Master Lease Database' })).toBeNull();
  });
  it('passes with exclude + a DOCUMENTS_PATH_INCLUDE narrowing (legacy lease-only mode)', () => {
    expect(reindexSafetyError({ DOCUMENTS_EXCLUDE: 'zzdemo', DOCUMENTS_PATH_INCLUDE: '(^|/)Leases(/)' })).toBeNull();
  });
  it('BLOCKS when DOCUMENTS_EXCLUDE is empty (the 2026-06-06 unscoped-sweep incident)', () => {
    expect(reindexSafetyError({ DOCUMENTS_INCLUDE_DIRS: 'Master Lease Database' })).toMatch(/DOCUMENTS_EXCLUDE/);
  });
  it('BLOCKS when the corpus is unscoped (exclude set, but no allowlist and no path-include)', () => {
    expect(reindexSafetyError({ DOCUMENTS_EXCLUDE: 'zzdemo' })).toMatch(/scoping|allowlist/i);
  });
  it('honors an explicit DOCUMENTS_ALLOW_UNSCOPED=1 override', () => {
    expect(reindexSafetyError({ DOCUMENTS_ALLOW_UNSCOPED: '1' })).toBeNull();
  });
});

describe('extractXlsxText — flat cell-text dump for search', () => {
  it('extracts sheet name + non-empty cell values', async () => {
    const root = mkdtempSync(join(tmpdir(), 'xlsx-'));
    try {
      const file = join(root, 'rent.xlsx');
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('RentRoll');
      ws.addRow(['Tenant', 'Suite', 'Annual Rent']);
      ws.addRow(['Eurosort', '100', 123450]);
      await wb.xlsx.writeFile(file);
      const text = await extractXlsxText(file);
      expect(text).toContain('RentRoll');
      expect(text).toContain('Eurosort');
      expect(text).toContain('123450');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// Deterministic fake embedder: 3-dim vectors keyed on simple token presence — no model, fully hermetic.
const fakeEmbedder: Embedder = async (texts) =>
  texts.map((t) => {
    const l = t.toLowerCase();
    return new Float32Array([
      l.includes('renew') ? 1 : 0,
      l.includes('roof') ? 1 : 0,
      l.includes('rent') ? 1 : 0,
    ]);
  });

const CHUNKS: DocChunk[] = [
  { docId: 'eurosort', docName: 'Eurosort Lease.pdf', idx: 0, text: 'Tenant has one option to renew for five years (the renewal option).' },
  { docId: 'roof', docName: 'Roof Warranty.pdf', idx: 0, text: 'The membrane roof carries a 20-year warranty.' },
  { docId: 'rent', docName: 'Rent Schedule.pdf', idx: 0, text: 'Base rent escalates 3% annually.' },
];

describe('buildIndex / queryIndex — sqlite-vec vector search (fake embedder)', () => {
  it('ranks the semantically nearest chunk first and shapes a cited, scored DocHit', async () => {
    const index = await buildIndex(CHUNKS, fakeEmbedder);
    const hits = await queryIndex(index, 'renewal', fakeEmbedder, 3);
    expect(hits[0]!.doc).toBe('Eurosort Lease.pdf');
    expect(hits[0]!.docId).toBe('eurosort');
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score); // closer = higher score
    expect(hits[0]!.snippet.toLowerCase()).toContain('renew');
    index.close();
  });

  it('returns nothing for an empty query or empty index', async () => {
    const empty = await buildIndex([], fakeEmbedder);
    expect(await queryIndex(empty, 'renewal', fakeEmbedder, 3)).toEqual([]);
    empty.close();
    const index = await buildIndex(CHUNKS, fakeEmbedder);
    expect(await queryIndex(index, '   ', fakeEmbedder, 3)).toEqual([]);
    index.close();
  });
});

describe('buildIndex on-disk — persist + reload + batched embedding (fake embedder)', () => {
  it('persists vectors + metadata to disk and reloads into a queryable index', async () => {
    const root = mkdtempSync(join(tmpdir(), 'diskidx-'));
    try {
      const dbPath = join(root, 'doc-index.sqlite');
      const built = await buildIndex(CHUNKS, fakeEmbedder, { dbPath });
      built.close(); // close the writer before reopening

      const { index, docs, builtAt } = loadDiskIndex(dbPath);
      expect(index.chunks.length).toBe(3);
      expect(docs.length).toBe(3); // Eurosort, Roof, Rent
      expect(builtAt).toMatch(/\d{4}-\d{2}-\d{2}T/); // ISO timestamp persisted

      const hits = await queryIndex(index, 'renewal', fakeEmbedder, 3);
      expect(hits[0]!.doc).toBe('Eurosort Lease.pdf');
      expect(hits[0]!.docId).toBe('eurosort');
      expect(hits[0]!.snippet.toLowerCase()).toContain('renew');
      index.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('embeds in batches (never one pass) and still ranks correctly', async () => {
    const root = mkdtempSync(join(tmpdir(), 'batchidx-'));
    try {
      const dbPath = join(root, 'doc-index.sqlite');
      const sizes: number[] = [];
      const spy: Embedder = async (texts) => {
        sizes.push(texts.length);
        return fakeEmbedder(texts);
      };
      let lastDone = 0;
      const built = await buildIndex(CHUNKS, spy, {
        dbPath,
        batchSize: 1,
        onProgress: (done, total) => {
          expect(total).toBe(3);
          lastDone = done;
        },
      });
      built.close();
      expect(Math.max(...sizes)).toBeLessThanOrEqual(1); // no single-pass embed of all 3
      expect(lastDone).toBe(3); // progress reached the end

      const { index } = loadDiskIndex(dbPath);
      const hits = await queryIndex(index, 'roof', fakeEmbedder, 3);
      expect(hits[0]!.doc).toBe('Roof Warranty.pdf');
      index.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('plans all chunks then embeds them across resumable passes (crash-safe)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'resumable-'));
    try {
      const dbPath = join(root, 'doc-index.sqlite');
      writeChunkPlan(dbPath, CHUNKS, 3); // fake embedder is 3-dim
      expect(indexCounts(dbPath)).toEqual({ planned: 3, embedded: 0, remaining: 3 });

      const p1 = await embedMissing(dbPath, fakeEmbedder, { batchSize: 1, limit: 2 });
      expect(p1.embedded).toBe(2);
      expect(p1.remaining).toBe(1);

      const p2 = await embedMissing(dbPath, fakeEmbedder, { batchSize: 1, limit: 10 });
      expect(p2.embedded).toBe(1);
      expect(p2.remaining).toBe(0);

      const p3 = await embedMissing(dbPath, fakeEmbedder, {}); // nothing left to do
      expect(p3).toEqual({ embedded: 0, remaining: 0 });

      const { index, docs } = loadDiskIndex(dbPath);
      expect(docs.length).toBe(3);
      const hits = await queryIndex(index, 'renewal', fakeEmbedder, 3);
      expect(hits[0]!.doc).toBe('Eurosort Lease.pdf');
      index.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('docIndexPath defaults under data/ and honors DOC_INDEX_PATH', () => {
    const prev = process.env.DOC_INDEX_PATH;
    try {
      delete process.env.DOC_INDEX_PATH;
      expect(docIndexPath().replace(/\\/g, '/')).toMatch(/\/data\/doc-index\.sqlite$/);
      process.env.DOC_INDEX_PATH = '/tmp/custom-index.sqlite';
      expect(docIndexPath()).toBe('/tmp/custom-index.sqlite');
    } finally {
      restoreEnv('DOC_INDEX_PATH', prev);
    }
  });
});

// NOTE: The real-model semantic proof (e.g. "ROFR" → "right of first refusal" with no shared
// keywords) is verified against the LIVE Brain Server endpoint (GET /api/documents/search), not
// here — transformers.js/onnxruntime hit a Float32Array realm mismatch under Vitest's test
// environment (the model runs fine in the real server's plain-Node process). Unit tests above cover
// the chunking, exclusion guard, and sqlite-vec plumbing with a deterministic fake embedder.

describe('shapeFused — fused rows become cited hits with a 0..1 score and an unchanged order', () => {
  const fused = (docName: string, score: number, extra: Partial<FusedRow> = {}): FusedRow => ({
    row: { chunk: { docId: docName, docName, idx: 3, text: 'Option to renew for five years.' }, distance: 1 },
    score,
    semantic: 0.5,
    alsoIn: [],
    draft: false,
    ...extra,
  });

  it('caps the score at 1 (boosted scores can exceed it) without reordering the hits', () => {
    const hits = shapeFused([fused('a.pdf', 1.07), fused('b.pdf', 1.03), fused('c.pdf', 0.6)], 'renewal');
    expect(hits.map((h) => h.doc)).toEqual(['a.pdf', 'b.pdf', 'c.pdf']);
    expect(hits.map((h) => h.score)).toEqual([1, 1, 0.6]);
    for (const h of hits) expect(h.score).toBeLessThanOrEqual(1);
  });

  it('carries the document, chunk index, alsoIn and draft flag, and a condensed snippet', () => {
    const [h] = shapeFused([fused('Business/X/Lease.pdf', 0.7, { alsoIn: ['Business/Y/Lease.pdf'], draft: true })], 'renewal');
    expect(h).toMatchObject({ doc: 'Business/X/Lease.pdf', chunkIdx: 3, alsoIn: ['Business/Y/Lease.pdf'], draft: true });
    expect(h!.snippet.toLowerCase()).toContain('renew');
  });
});
