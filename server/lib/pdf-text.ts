// server/lib/pdf-text.ts
//
// Single shared PDF→text adapter over pdf-parse v2 (pdfjs-dist 5.x). Preserves the
// `(buffer) => Promise<{ text: string }>` shape every caller already used with v1, so
// call sites (om-extract, documents RAG, briefing tests) stay one-line consumers.
//
// WHY v2 + the copy: Node >=24.18 raised Buffer.poolSize to 64 KiB (nodejs/node#63597),
// so 4–32 KiB Buffers are views into a shared slab at nonzero byteOffset. pdf-parse v1's
// bundled pdf.js 1.10 re-based sub-streams to the raw ArrayBuffer's byte 0 and read slab
// garbage ('bad XRef entry'). v2's modern pdfjs normalizes input, and the fresh
// Uint8Array copy below guarantees byteOffset 0 regardless — defense in depth, and pdf.js
// may transfer/detach the buffer it is handed, so callers keep ownership of theirs.
import { PDFParse } from 'pdf-parse';

export async function pdfToText(data: Buffer | Uint8Array): Promise<{ text: string }> {
  const parser = new PDFParse({ data: new Uint8Array(data) });
  try {
    const { text } = await parser.getText();
    return { text };
  } finally {
    await parser.destroy();
  }
}
