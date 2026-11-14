# Plan: Oxford Edge news overlay (2026-10-08)

Lane L3 (feature). Requested by Gabriel after the 2026-10-08 news review of the Edge metro rankings.

## Goal
Show the dated news signals (Improving / Weakening / Mixed / none) per metro in Acquisitions > Edge, without changing any series value, rank or score.

## Design
- Source: `news_overlay.json` beside `markets.json` in the oxford-edge output folder. Read-only from the app; written by the research workflow, never by the app.
- Contract (Architect-owned `src/contracts/edge.ts`, additive only): `EdgeNewsSignal`, `EdgeNewsEntry`, `EdgeNewsResponse`.
- Server: `server/edge/news.ts` (readFileSync only, strict schema, sanitized errors, 7-day stale rule, future asOf fails closed). Route `GET /api/warehouse/edge/news` in `edge-api.ts`, no warehouse guard.
- Client: `useEdgeNews` (optional, a failure never blocks the board), banner under the freshness banner, "News signal" column on the board when the overlay loaded, note in the market detail panel. Stale overlay shows NEWS STALE and every signal reads "(stale)".
- Not done: no sort-by-signal (the board stays sorted by observed values only, spec section 2), no composite, no scoring, nothing on the mirror or AI tools.

## Failure modes covered by tests
missing file, I/O error, bad JSON, schema drift, duplicate ids, future/invalid asOf, stale overlay, news fetch failing while markets load.

## Gates
`npm run gate`, new `tests/unit/edge-news.test.tsx`, existing edge-* suites unchanged. `architecture/status.json` entry with review_needed for the contract touch. No merge: Gabriel owns integration to main.
