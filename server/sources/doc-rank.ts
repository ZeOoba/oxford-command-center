// server/sources/doc-rank.ts
//
// Pure entity detection + candidate fusion + re-ranking for document search. No I/O, no embedding —
// everything here works on the document list and on rows the worker already returned, so it is cheap to test
// and cannot touch the index.
//
// WHY (measured 2026-10-14, live index of 150,656 chunks): a pure vector search ranked the Dibita renewal
// clause 55th-127th for every phrasing of "what is the renewal option in the Dibita lease", because ~450
// chunks in ~370 documents carry near-identical "option to renew" boilerplate (scores are flat, 0.51-0.63) and
// identical copies of one file (Master Lease Database) fill result slots. The agent only ever saw the top 5.
//
// The fix has four parts, all here:
//  1. ENTITY DETECTION FROM THE CORPUS: a word in the question counts as a name only if it actually occurs in
//     document PATHS (a vocabulary built from the index's own document list) and is distinctive (few documents).
//     Capitalized / ALL-CAPS / numeric words win over lowercase ones, so "…for Dibita" beats "…expense…".
//     This replaced a stop-word heuristic that dropped real names behind generic words and could never see
//     short ("QRT") or non-ASCII ("Café") names.
//  2. SCOPE BY EXACT DOCUMENTS: the entity words pick a bounded set of document names; the worker fetches
//     exactly those documents' chunks (no substring guessing, size known in advance).
//  3. RE-RANK: one path-match boost (not per word, so generic path words cannot out-vote the name), a text-match
//     boost, and a draft demotion; byte-identical copies collapse into one hit that lists the other paths, and an
//     executed copy always beats a draft copy of identical text.
//  4. A question with no named entity falls back to the plain semantic order (after de-duplication).
import { createHash } from 'node:crypto';
import type { KnnRow } from './doc-index-protocol';

/** Added once when the document PATH contains any entity word. */
export const PATH_TERM_BOOST = 0.12;
/** Added for each ADDITIONAL entity word in the path (max 2 extra) — a small tie-breaker, never a vote. */
export const PATH_EXTRA_BOOST = 0.02;
/** Added when the question names SEVERAL entities and the path contains ALL of them ("Example Grill": the
 *  Grill extension beats the 20 other Westminster-only tenant leases). Never applies to a single entity word, and a
 *  document matching only some words never gets it, so generic words still cannot out-vote the name. */
export const ALL_TERMS_BOOST = 0.08;
/** Added once when the chunk TEXT contains any entity word. */
export const TEXT_TERM_BOOST = 0.03;
/** Subtracted when the file name marks a negotiation draft / markup, so the executed instrument wins. */
export const DRAFT_PENALTY = 0.06;
/** Most entity words we act on. 6, not 4: the scope is an INTERSECTION of the words' documents, so extra words
 *  narrow it rather than widen it, and a low cap let incidental one-document words ("Avenue") crowd out a real
 *  name ("QRT") when picking the rarest. */
export const MAX_ENTITY_TERMS = 6;
/** A word in more than this many documents is too common to be a name. */
export const MAX_TERM_DOCS = 120;
/** Most documents an entity lookup may scope to. */
export const MAX_SCOPED_DOCS = 200;
/** Shortest word that may be a name ("QRT", "UPS"). */
export const MIN_TERM_LENGTH = 3;

/** Generic lease/question words that never identify a document. */
const STOP = new Set(
  (
    'what which when where who whom whose does doing have having with without from that this these those they ' +
    'their there then than into onto over under about after before between during said says show tell give find ' +
    'search list please cite citation cited source sources document documents file files lease leases leased ' +
    'leasing renew renewal renewals renewing option options clause clauses term terms tenant tenants landlord ' +
    'rent rental rents roll expire expires expiry expiration date dates agreement agreements amendment ' +
    'amendments addendum addenda property properties building premises notice provision provisions section ' +
    'article signed executed current latest last first many much some each every other same such only also ' +
    'been being were will would could should shall long period years year months month days the and for are ' +
    'was how any all can may per via'
  ).split(' '),
);

const WORD_RE = /[\p{L}\p{N}]+/gu;

/** Document-frequency vocabulary of the words that occur in document paths. */
export interface PathVocab {
  /** Number of documents whose path contains `token` (lower-case); 0 when absent. */
  df(token: string): number;
  /** Names of those documents. */
  docsOf(token: string): readonly string[];
}

/** Build the vocabulary from the index's own document list (names are the indexed paths). */
export function buildPathVocab(docs: ReadonlyArray<{ name: string }>): PathVocab {
  const byToken = new Map<string, string[]>();
  for (const d of docs) {
    const seen = new Set<string>();
    for (const m of d.name.toLowerCase().matchAll(WORD_RE)) {
      const t = m[0];
      if (t.length < MIN_TERM_LENGTH || seen.has(t)) continue;
      seen.add(t);
      const list = byToken.get(t);
      if (list) list.push(d.name);
      else byToken.set(t, [d.name]);
    }
  }
  return { df: (t) => byToken.get(t)?.length ?? 0, docsOf: (t) => byToken.get(t) ?? [] };
}

export interface EntityPick {
  /** Entity words used for boosting, rarest first (lower-case). */
  terms: string[];
  /** Exact indexed document names to scope the entity lookup to. */
  docNames: string[];
}

const NONE: EntityPick = { terms: [], docNames: [] };

/** A word that looks like a NAME in the question: has a digit or any capital letter (Capitalized, ALL-CAPS, mixed).
 *  Sentence position does not matter: question words ("What", "Which") are stop words and never reach this test, so a
 *  capitalized word that is in the corpus vocabulary and not generic is a name even at the start of the question. */
function looksLikeName(raw: string): boolean {
  return /\d/.test(raw) || raw !== raw.toLowerCase();
}

/**
 * The distinctive names in a question, grounded in the corpus: words present in document paths, not generic,
 * and in at most MAX_TERM_DOCS documents. Name-like words (see looksLikeName) win over lowercase ones; the
 * rarest words are kept, capped at MAX_ENTITY_TERMS. The scope is the documents containing ALL the words,
 * else (dropping the most common word until something matches) the documents containing the most specific
 * subset; if even the rarest two share no document, the union of the two rarest words' documents.
 */
export function pickEntities(query: string, vocab: PathVocab): EntityPick {
  type Cand = { low: string; name: boolean; df: number };
  const cands: Cand[] = [];
  for (const m of query.matchAll(WORD_RE)) {
    const raw = m[0];
    const low = raw.toLowerCase();
    if (low.length < MIN_TERM_LENGTH || STOP.has(low) || cands.some((c) => c.low === low)) continue;
    const df = vocab.df(low);
    if (df < 1 || df > MAX_TERM_DOCS) continue;
    cands.push({ low, name: looksLikeName(raw), df });
  }
  if (cands.length === 0) return NONE;
  const pool = cands.some((c) => c.name) ? cands.filter((c) => c.name) : cands;
  const chosen = [...pool].sort((a, b) => a.df - b.df || a.low.localeCompare(b.low)).slice(0, MAX_ENTITY_TERMS);
  const terms = chosen.map((c) => c.low);

  // Most specific scope first: documents containing ALL words, then drop the most common word, ... down to
  // the two rarest. If even those two share no document, take the union of the two rarest words' documents
  // (better recall than guessing one); a single word is just its documents.
  for (let k = terms.length; k >= 2; k -= 1) {
    const sets = terms.slice(0, k).map((t) => vocab.docsOf(t));
    const inter = (sets[0] ?? []).filter((n) => sets.every((s) => s.includes(n)));
    if (inter.length > 0) return { terms, docNames: inter.slice(0, MAX_SCOPED_DOCS) };
  }
  const union = [...new Set(terms.slice(0, 2).flatMap((t) => vocab.docsOf(t)))];
  return { terms, docNames: union.slice(0, MAX_SCOPED_DOCS) };
}

const DRAFT_MARKER = /(draft|redline|markup|blackline|comment|proposal|proposed)/;
const EXECUTED_MARKER = /(^|[^a-z])(executed|signed|countersigned|final)([^a-z]|$)/;

/**
 * True when the FILE NAME (not the folder path) marks a negotiation draft, markup or proposal. Substring match,
 * so "LeaseDraft", "markups" and "comments" are caught; an explicit "executed"/"signed"/"final" marker wins
 * ("Lease - Executed no comments.pdf" is NOT a draft) unless it is "final draft".
 */
export function isDraftDoc(docName: string): boolean {
  const base = (docName.split(/[\\/]/).pop() ?? docName).toLowerCase();
  if (/final[ _-]*draft/.test(base)) return true;
  return DRAFT_MARKER.test(base) && !EXECUTED_MARKER.test(base);
}

/** Whitespace/case-insensitive identity of a chunk's text, so copies of one file filed in several folders collapse. */
export function textKey(text: string): string {
  return createHash('sha1').update(text.toLowerCase().replace(/\s+/g, ' ').trim()).digest('hex');
}

export interface FusedRow {
  row: KnnRow;
  /** Final ranking score (semantic + boosts - penalties). Not a probability; only the order matters. */
  score: number;
  /** Plain 1/(1+distance) similarity before any boost. */
  semantic: number;
  /** Other documents carrying the identical chunk text (copies in other folders). */
  alsoIn: string[];
  /** The file name marks a draft / markup / proposal. */
  draft: boolean;
}

export interface FuseInput {
  /** Entity words from `pickEntities` (lower-case); [] → plain semantic order. */
  terms: readonly string[];
  /** Wide global vector pool, closest first. */
  knn: readonly KnnRow[];
  /** Chunks of the entity-scoped documents, with their distance to the query. */
  scoped: readonly KnnRow[];
  limit: number;
}

export function fuseCandidates({ terms, knn, scoped, limit }: FuseInput): FusedRow[] {
  // 1. Merge the two pools: one row per (document, chunk), keeping the closest distance.
  const merged = new Map<string, KnnRow>();
  for (const r of [...knn, ...scoped]) {
    if (!Number.isFinite(r.distance) || r.chunk.text.trim().length === 0) continue;
    const id = `${r.chunk.docName}\u0000${r.chunk.idx}`;
    const prev = merged.get(id);
    if (!prev || r.distance < prev.distance) merged.set(id, r);
  }

  // 2. Score, and 3. collapse byte-identical text across paths. The canonical copy is the NON-draft one if
  //    any copy is non-draft (an executed lease beats a draft of the same words), else the best-scoring one.
  const best = new Map<string, FusedRow>();
  for (const r of merged.values()) {
    const semantic = 1 / (1 + r.distance);
    const path = r.chunk.docName.toLowerCase();
    const text = r.chunk.text.toLowerCase();
    let pathHits = 0;
    let textHit = false;
    for (const t of terms) {
      if (path.includes(t)) pathHits += 1;
      if (text.includes(t)) textHit = true;
    }
    const draft = isDraftDoc(r.chunk.docName);
    const score =
      semantic +
      (pathHits > 0 ? PATH_TERM_BOOST + Math.min(pathHits - 1, 2) * PATH_EXTRA_BOOST : 0) +
      (terms.length > 1 && pathHits === terms.length ? ALL_TERMS_BOOST : 0) +
      (textHit ? TEXT_TERM_BOOST : 0) -
      (draft ? DRAFT_PENALTY : 0);
    const key = textKey(r.chunk.text);
    const cand: FusedRow = { row: r, score, semantic, alsoIn: [], draft };
    const prev = best.get(key);
    if (!prev) {
      best.set(key, cand);
      continue;
    }
    const candWins = prev.draft !== cand.draft ? !cand.draft : cand.score > prev.score;
    const [winner, loser] = candWins ? [cand, prev] : [prev, cand];
    const others = new Set([...winner.alsoIn, ...loser.alsoIn, loser.row.chunk.docName]);
    others.delete(winner.row.chunk.docName);
    winner.alsoIn = [...others];
    best.set(key, winner);
  }

  // 4. Order: score desc, then a stable tie-break so results are deterministic.
  return [...best.values()]
    .sort((a, b) => b.score - a.score || a.row.chunk.docName.localeCompare(b.row.chunk.docName) || a.row.chunk.idx - b.row.chunk.idx)
    .slice(0, limit);
}
