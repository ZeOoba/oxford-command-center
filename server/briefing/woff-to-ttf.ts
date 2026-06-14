// server/briefing/woff-to-ttf.ts
//
// A minimal, dependency-free WOFF1 → TTF (sfnt) decoder. SERVER-ONLY.
//
// WHY: the brand faces ship from @fontsource as .woff/.woff2 (fontsource v5 dropped raw .ttf).
// react-pdf's bundled fontkit cannot embed them reliably — the .woff codepath crashes on the
// space glyph (TTFGlyph._getCBox) and the .woff2 subsetter crashes on embed (TTFSubset._addGlyph).
// fontkit's TTF path, by contrast, subsets and embeds cleanly. A WOFF1 file is simply an sfnt whose
// per-table payloads are individually zlib-DEFLATE-compressed (or stored), wrapped in a 44-byte
// header + a 20-byte-per-table directory (WOFF 1.0 spec, W3C). So we decompress each table with
// node:zlib and re-assemble a standard TTF — pure Node, offline, deterministic. No web fetch, no dep.
import { inflateSync } from 'node:zlib';

const WOFF_SIGNATURE = 'wOFF';

interface WoffTable {
  tag: string;
  checksum: number;
  data: Buffer;
  origLength: number;
}

/** Decode a WOFF 1.0 buffer into a standard TTF (sfnt) buffer. Throws on a non-WOFF1 input. */
export function woffToTtf(woff: Buffer): Buffer {
  if (woff.toString('latin1', 0, 4) !== WOFF_SIGNATURE) {
    throw new Error('woffToTtf: input is not a WOFF 1.0 file (bad signature)');
  }
  const u32 = (o: number): number => woff.readUInt32BE(o);
  const u16 = (o: number): number => woff.readUInt16BE(o);

  const flavor = u32(4); // the wrapped sfnt version (e.g. 0x00010000 truetype, 'OTTO' cff)
  const numTables = u16(12);

  // Table directory: 44-byte header, then 20 bytes per table.
  const tables: WoffTable[] = [];
  let p = 44;
  for (let i = 0; i < numTables; i++) {
    const tag = woff.toString('latin1', p, p + 4);
    const offset = u32(p + 4);
    const compLength = u32(p + 8);
    const origLength = u32(p + 12);
    const checksum = u32(p + 16);
    const slice = woff.subarray(offset, offset + compLength);
    // A table is stored uncompressed iff compLength === origLength; otherwise it is zlib-deflated.
    const data = compLength < origLength ? Buffer.from(inflateSync(slice)) : Buffer.from(slice);
    tables.push({ tag, checksum, data, origLength });
    p += 20;
  }

  // Re-emit a standard sfnt. Table records MUST be sorted by tag ascending.
  tables.sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));

  const numT = tables.length;
  // searchRange = (largest power of two ≤ numT) × 16; entrySelector = log2 of that power; rangeShift.
  let pow = 1;
  while (pow * 2 <= numT) pow *= 2;
  const searchRange = pow * 16;
  const entrySelector = Math.floor(Math.log2(pow));
  const rangeShift = numT * 16 - searchRange;

  const header = Buffer.alloc(12);
  header.writeUInt32BE(flavor, 0);
  header.writeUInt16BE(numT, 4);
  header.writeUInt16BE(searchRange, 6);
  header.writeUInt16BE(entrySelector, 8);
  header.writeUInt16BE(rangeShift, 10);

  const directory = Buffer.alloc(16 * numT);
  const bodies: Buffer[] = [];
  let offset = 12 + 16 * numT;
  tables.forEach((t, i) => {
    directory.write(t.tag, i * 16, 'latin1');
    directory.writeUInt32BE(t.checksum, i * 16 + 4);
    directory.writeUInt32BE(offset, i * 16 + 8);
    directory.writeUInt32BE(t.origLength, i * 16 + 12);
    bodies.push(t.data);
    const pad = (4 - (t.data.length % 4)) % 4; // each table is 4-byte aligned
    if (pad) bodies.push(Buffer.alloc(pad));
    offset += t.data.length + pad;
  });

  return Buffer.concat([header, directory, ...bodies]);
}
