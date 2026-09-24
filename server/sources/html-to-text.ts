const ENTITIES: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'",
  // Typographic entities Outlook/Word-generated bodies emit by name (T13).
  rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', mdash: '—', ndash: '–', hellip: '…',
};

/** Decode one numeric entity; returns the original match when the code point is not a valid Unicode
 *  scalar (String.fromCodePoint throws RangeError on NaN, negatives and anything above 0x10FFFF — one
 *  malformed entity must never take the whole feed down; 2026-09-23 review I-4). */
function decodeCodePoint(cp: number, original: string): string {
  return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : original;
}

/** Plain text from an Outlook/Graph HTML body. The old tag-only regex kept <style> CSS and &nbsp;. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    // An UNCLOSED <style>/<script>/<head> (truncated body) is CSS/script/metadata to the end of the string.
    .replace(/<(style|script|head)[^>]*>[\s\S]*$/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
      const k = e.toLowerCase();
      if (k in ENTITIES) return ENTITIES[k]!;
      if (k.startsWith('#x')) return decodeCodePoint(parseInt(k.slice(2), 16), m);
      if (k.startsWith('#')) return decodeCodePoint(parseInt(k.slice(1), 10), m);
      return m;
    })
    .replace(/\s+/g, ' ')
    .trim();
}
