// @vitest-environment node
//
// tests/unit/woff-to-ttf.test.ts
//
// Unit tests for server/briefing/woff-to-ttf.ts — the minimal WOFF1→TTF decoder.
// All tests are pure: they construct synthetic WOFF buffers from scratch, so no font
// file access is required and the suite runs offline/deterministically.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { woffToTtf } from '../../server/briefing/woff-to-ttf';

const _require = createRequire(import.meta.url);

// ── WOFF buffer construction helpers ──────────────────────────────────────────────────────────

const TRUETYPE_FLAVOR = 0x00010000;

interface TableSpec {
  tag: string; // exactly 4 bytes
  data: Buffer;
  compress?: boolean; // if true, deflate the payload
}

/**
 * Build a minimal, spec-compliant WOFF 1.0 buffer from a list of table specs.
 * Mirrors the WOFF 1.0 W3C spec: 44-byte header + 20-byte-per-table directory + payloads.
 */
function buildWoff(tables: TableSpec[], flavor = TRUETYPE_FLAVOR): Buffer {
  const numTables = tables.length;

  // Lay out table data and decide offsets (payloads start after 44-byte header + 20*n directory).
  const dirOffset = 44;
  const payloadStart = dirOffset + 20 * numTables;

  type TableEntry = {
    tag: string;
    origLength: number;
    compLength: number;
    checksum: number;
    payload: Buffer;
  };

  const entries: TableEntry[] = [];
  let payloadOffset = payloadStart;

  for (const t of tables) {
    const origData = t.data;
    const compData = t.compress ? deflateSync(origData) : origData;
    const compLength = compData.length;
    const origLength = origData.length;
    // Compute a trivial checksum (just a sum of bytes for testing — not a real SFNT checksum, but
    // we don't validate checksums so it doesn't matter for these tests).
    let checksum = 0;
    for (const b of origData) checksum = (checksum + b) & 0xffffffff;
    entries.push({ tag: t.tag, origLength, compLength, checksum, payload: compData });
    payloadOffset += compLength;
  }

  // Total WOFF file size (needed by spec header; not actually used by woffToTtf but must be ≥ real size).
  const totalLength = payloadOffset;

  const buf = Buffer.alloc(totalLength + 256, 0); // extra slack
  let p = 0;

  // Header (44 bytes).
  buf.write('wOFF', p, 'latin1'); p += 4;      // signature
  buf.writeUInt32BE(flavor, p); p += 4;           // flavor (sfnt version)
  buf.writeUInt32BE(totalLength, p); p += 4;      // length
  buf.writeUInt16BE(numTables, p); p += 2;        // numTables
  buf.writeUInt16BE(0, p); p += 2;                // reserved
  buf.writeUInt32BE(0, p); p += 4;                // totalSfntSize
  buf.writeUInt16BE(1, p); p += 2;                // majorVersion
  buf.writeUInt16BE(0, p); p += 2;                // minorVersion
  buf.writeUInt32BE(0, p); p += 4;                // metaOffset
  buf.writeUInt32BE(0, p); p += 4;                // metaLength
  buf.writeUInt32BE(0, p); p += 4;                // metaOrigLength
  buf.writeUInt32BE(0, p); p += 4;                // privOffset
  buf.writeUInt32BE(0, p); p += 4;                // privLength

  // Directory entries (20 bytes each) — payloads immediately follow the directory in order.
  let currentPayloadOffset = payloadStart;
  for (const e of entries) {
    buf.write(e.tag.padEnd(4, '\0').slice(0, 4), p, 'latin1'); p += 4;
    buf.writeUInt32BE(currentPayloadOffset, p); p += 4;   // offset into WOFF file
    buf.writeUInt32BE(e.compLength, p); p += 4;
    buf.writeUInt32BE(e.origLength, p); p += 4;
    buf.writeUInt32BE(e.checksum, p); p += 4;
    currentPayloadOffset += e.compLength;
  }

  // Payloads.
  for (const e of entries) {
    e.payload.copy(buf, p);
    p += e.compLength;
  }

  return buf.subarray(0, p);
}

// ── Tests ──────────────────────────────────────────────────────────────────────────────────────

describe('woffToTtf — input validation', () => {
  it('throws on a buffer with a wrong signature (not wOFF)', () => {
    const bad = Buffer.from('OTTOabcd', 'latin1');
    expect(() => woffToTtf(bad)).toThrow(/WOFF 1.0/);
    expect(() => woffToTtf(bad)).toThrow(/signature/);
  });

  it('throws on a buffer starting with wOF2 (WOFF2, not WOFF1)', () => {
    const woff2Header = Buffer.alloc(8, 0);
    woff2Header.write('wOF2', 0, 'latin1');
    expect(() => woffToTtf(woff2Header)).toThrow(/not a WOFF 1.0/);
  });

  it('throws on an empty buffer', () => {
    expect(() => woffToTtf(Buffer.alloc(0))).toThrow();
  });

  it('throws on a corrupt WOFF where compLength > origLength for a table', () => {
    // Build a valid WOFF first, then manually patch the directory to claim compLength > origLength.
    const tableData = Buffer.from('hello world', 'utf8');
    const woff = buildWoff([{ tag: 'test', data: tableData }]);
    // The directory entry starts at byte 44. compLength is at offset +8, origLength at +12.
    const dirStart = 44;
    const origLength = woff.readUInt32BE(dirStart + 12);
    // Write compLength = origLength + 1 (corrupt).
    woff.writeUInt32BE(origLength + 1, dirStart + 8);
    expect(() => woffToTtf(woff)).toThrow(/corrupt WOFF/);
    expect(() => woffToTtf(woff)).toThrow(/compLength/);
  });
});

describe('woffToTtf — output structure', () => {
  it('produces a buffer whose first 4 bytes are the flavor (sfnt version)', () => {
    const tableData = Buffer.from('ABCDEFGHIJKLMNOP', 'utf8'); // 16 bytes
    const woff = buildWoff([{ tag: 'tabl', data: tableData }]);
    const ttf = woffToTtf(woff);
    // First 4 bytes of the sfnt must be the flavor (0x00010000 = TrueType).
    expect(ttf.readUInt32BE(0)).toBe(TRUETYPE_FLAVOR);
  });

  it('writes the correct numTables into the sfnt header', () => {
    const t1 = Buffer.from('table one payload', 'utf8');
    const t2 = Buffer.from('table two payload', 'utf8');
    const woff = buildWoff([
      { tag: 'aaa1', data: t1 },
      { tag: 'bbb2', data: t2 },
    ]);
    const ttf = woffToTtf(woff);
    // sfnt header: [flavor(4)] [numTables(2)] ...
    expect(ttf.readUInt16BE(4)).toBe(2);
  });

  it('table directory is sorted ascending by tag in the output TTF', () => {
    // Provide tables deliberately out of order.
    const payloadZ = Buffer.alloc(4, 0xaa);
    const payloadA = Buffer.alloc(4, 0xbb);
    const woff = buildWoff([
      { tag: 'ztag', data: payloadZ },
      { tag: 'atag', data: payloadA },
    ]);
    const ttf = woffToTtf(woff);
    // sfnt directory starts at byte 12; each entry is 16 bytes; tags are at entry[i*16].
    const tag0 = ttf.toString('latin1', 12, 16);
    const tag1 = ttf.toString('latin1', 28, 32);
    expect(tag0 < tag1).toBe(true); // must be sorted ascending
    expect(tag0).toBe('atag');
    expect(tag1).toBe('ztag');
  });

  it('recovers stored (uncompressed) table data verbatim', () => {
    const originalPayload = Buffer.from('stored-table-payload-data', 'utf8');
    // compress: false → compLength === origLength → stored path in woffToTtf
    const woff = buildWoff([{ tag: 'test', data: originalPayload, compress: false }]);
    const ttf = woffToTtf(woff);
    // Find the table body: sfnt dir[0] offset is at byte 12+8=20 in sfnt header.
    const tableOffset = ttf.readUInt32BE(12 + 8);
    const tableLength = ttf.readUInt32BE(12 + 12);
    const recovered = ttf.subarray(tableOffset, tableOffset + tableLength);
    expect(Buffer.compare(recovered, originalPayload)).toBe(0);
  });

  it('recovers compressed (deflated) table data after decompression', () => {
    // Use a large, compressible payload so deflate actually reduces size (ensures the
    // compress: true path takes the decompression branch in woffToTtf).
    const originalPayload = Buffer.from('A'.repeat(200), 'utf8');
    const woff = buildWoff([{ tag: 'cmpr', data: originalPayload, compress: true }]);
    // Verify our builder actually deflated it (compLength < origLength).
    const dirStart = 44;
    const compLength = woff.readUInt32BE(dirStart + 8);
    const origLength = woff.readUInt32BE(dirStart + 12);
    expect(compLength).toBeLessThan(origLength); // precondition: compression happened

    const ttf = woffToTtf(woff);
    const tableOffset = ttf.readUInt32BE(12 + 8);
    const tableLength = ttf.readUInt32BE(12 + 12);
    const recovered = ttf.subarray(tableOffset, tableOffset + tableLength);
    expect(Buffer.compare(recovered, originalPayload)).toBe(0);
  });

  it('each table is 4-byte aligned in the output', () => {
    // Three tables of non-multiple-of-4 lengths — all must land at 4-byte aligned offsets.
    const t1 = Buffer.alloc(3, 0x11);
    const t2 = Buffer.alloc(5, 0x22);
    const t3 = Buffer.alloc(7, 0x33);
    const woff = buildWoff([
      { tag: 'aa11', data: t1 },
      { tag: 'bb22', data: t2 },
      { tag: 'cc33', data: t3 },
    ]);
    const ttf = woffToTtf(woff);
    const numT = ttf.readUInt16BE(4);
    for (let i = 0; i < numT; i++) {
      const offset = ttf.readUInt32BE(12 + i * 16 + 8);
      expect(offset % 4).toBe(0);
    }
  });

  it('is deterministic: same WOFF input → identical TTF output', () => {
    const payload = Buffer.from('repeatable-deterministic-payload', 'utf8');
    const woff = buildWoff([{ tag: 'dett', data: payload }]);
    const ttf1 = woffToTtf(woff);
    const ttf2 = woffToTtf(woff);
    expect(Buffer.compare(ttf1, ttf2)).toBe(0);
  });
});

describe('woffToTtf — sfnt header values (searchRange / entrySelector / rangeShift)', () => {
  // These offsets guard the binary search helper fields required by sfnt readers.
  it('computes correct binary-search fields for a 2-table font', () => {
    const t1 = Buffer.alloc(4, 0x01);
    const t2 = Buffer.alloc(4, 0x02);
    const woff = buildWoff([
      { tag: 'aa11', data: t1 },
      { tag: 'bb22', data: t2 },
    ]);
    const ttf = woffToTtf(woff);
    // For numTables=2: largest power of 2 ≤ 2 is 2; searchRange=2*16=32; entrySelector=1; rangeShift=0.
    expect(ttf.readUInt16BE(6)).toBe(32); // searchRange
    expect(ttf.readUInt16BE(8)).toBe(1);  // entrySelector
    expect(ttf.readUInt16BE(10)).toBe(0); // rangeShift
  });

  it('computes correct binary-search fields for a 3-table font', () => {
    const tables: TableSpec[] = [
      { tag: 'aa11', data: Buffer.alloc(4, 0x01) },
      { tag: 'bb22', data: Buffer.alloc(4, 0x02) },
      { tag: 'cc33', data: Buffer.alloc(4, 0x03) },
    ];
    const woff = buildWoff(tables);
    const ttf = woffToTtf(woff);
    // numTables=3: largest power of 2 ≤ 3 is 2; searchRange=2*16=32; entrySelector=1; rangeShift=3*16-32=16.
    expect(ttf.readUInt16BE(6)).toBe(32); // searchRange
    expect(ttf.readUInt16BE(8)).toBe(1);  // entrySelector
    expect(ttf.readUInt16BE(10)).toBe(16); // rangeShift = 3*16 - 32
  });

  it('computes correct binary-search fields for a 4-table font', () => {
    const tables: TableSpec[] = [
      { tag: 'aa11', data: Buffer.alloc(4, 0x01) },
      { tag: 'bb22', data: Buffer.alloc(4, 0x02) },
      { tag: 'cc33', data: Buffer.alloc(4, 0x03) },
      { tag: 'dd44', data: Buffer.alloc(4, 0x04) },
    ];
    const woff = buildWoff(tables);
    const ttf = woffToTtf(woff);
    // numTables=4: largest power of 2 ≤ 4 is 4; searchRange=4*16=64; entrySelector=2; rangeShift=0.
    expect(ttf.readUInt16BE(6)).toBe(64); // searchRange
    expect(ttf.readUInt16BE(8)).toBe(2);  // entrySelector
    expect(ttf.readUInt16BE(10)).toBe(0); // rangeShift
  });
});

describe('woffToTtf — real WOFF file round-trip (brand font)', () => {
  // This test uses the actual @fontsource WOFF asset, requiring the package to be installed.
  // It verifies the decoder doesn't crash on a real font and the output starts with the sfnt signature.
  it('decodes a real @fontsource WOFF without throwing and the result starts with a valid sfnt signature', () => {
    let woffPath: string;
    try {
      woffPath = _require.resolve('@fontsource/dm-sans/files/dm-sans-latin-400-normal.woff');
    } catch {
      // Package not installed — skip gracefully.
      return;
    }
    const woffBuf = readFileSync(woffPath);
    const ttf = woffToTtf(woffBuf);
    // A TrueType sfnt starts with 0x00010000, or 'OTTO' (CFF), or 'true', or 'typ1'.
    const flavor = ttf.readUInt32BE(0);
    const knownFlavors = new Set([
      0x00010000, // TrueType outlines
      0x4f54544f, // 'OTTO' CFF outlines
      0x74727565, // 'true' (Apple TrueType)
      0x74797031, // 'typ1'
    ]);
    expect(knownFlavors.has(flavor)).toBe(true);
    // Must have at least one table.
    expect(ttf.readUInt16BE(4)).toBeGreaterThan(0);
  });
});
