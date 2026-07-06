// server/warehouse/brain-api.ts
//
// Command Brain sub-router (Phase 5a.2). This file exports a Hono factory ONLY — mounting it at
// /api/warehouse/brain (alongside debt/leasing/capital's identical pattern) is the orchestrator's
// job in server/index.ts, not this file's.
//
// Routes:
//   GET  /report   — buildBrainReport(db, <request-time ISO timestamp>), Zod-parsed through
//                    BrainReport before it crosses the wire (H6 read-boundary discipline).
//   POST /feedback — FeedbackInput.parse(body) → INSERT into recommendation_feedback. Append-only:
//                    a duplicate/updated decision for the same (subjectKind, subjectId) is simply a
//                    NEW row with a later decidedAt (021_recommendation_feedback.sql's own comment)
//                    — "latest wins" is a reader/UI concern, never enforced at write time here.
//   GET  /feedback — every recorded feedback decision, newest first, Zod-parsed as an array.
//
// Error policy: 503 when the warehouse is unavailable — the withDb guard is a byte-for-byte port
// of server/warehouse/debt-api.ts's own withDb (same pattern, independently duplicated per-router
// across this codebase rather than shared, so this file introduces no new coupling).
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import type { WarehouseDb } from './db';
import { buildBrainReport } from './brain-report';
import { BrainReport, FeedbackDecision, FeedbackInput } from '../../src/contracts/brain-report';

interface FeedbackRow {
  id: string;
  subject_kind: string;
  subject_id: string;
  decision: string;
  decided_at: string;
  note: string | null;
}

function toFeedbackDecisionShape(r: FeedbackRow): unknown {
  return {
    id: r.id,
    subjectKind: r.subject_kind,
    subjectId: r.subject_id,
    decision: r.decision,
    decidedAt: r.decided_at,
    note: r.note,
  };
}

export function brainApi(getDb: () => WarehouseDb): Hono {
  const app = new Hono();

  /** Resolve the warehouse per-request behind a 503 guard. Mirrors debt-api.ts's withDb exactly. */
  const withDb = (handler: (db: WarehouseDb) => Response | Promise<Response>) => {
    let db: WarehouseDb;
    try {
      db = getDb();
    } catch {
      return Promise.resolve(
        new Response(JSON.stringify({ error: 'warehouse unavailable' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    return handler(db);
  };

  // ── GET /report ────────────────────────────────────────────────────────────────────────
  app.get('/report', (c) =>
    withDb((db) => {
      try {
        const report = buildBrainReport(db, new Date().toISOString());
        return c.json(BrainReport.parse(report));
      } catch (err) {
        console.error('[brain-api] /report error:', err instanceof Error ? err.message : String(err));
        return c.json({ error: 'brain report failed' }, 500);
      }
    }),
  );

  // ── POST /feedback ─────────────────────────────────────────────────────────────────────
  app.post('/feedback', (c) =>
    withDb(async (db) => {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'Invalid JSON body' }, 400);
      }
      const parsed = FeedbackInput.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: parsed.error.issues.map((i) => i.message).join('; ') }, 400);
      }
      try {
        const id = randomUUID();
        const decidedAt = new Date().toISOString();
        const note = parsed.data.note ?? null;
        db.prepare(`
          INSERT INTO recommendation_feedback (id, subject_kind, subject_id, decision, decided_at, note)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(id, parsed.data.subjectKind, parsed.data.subjectId, parsed.data.decision, decidedAt, note);

        return c.json(FeedbackDecision.parse({
          id,
          subjectKind: parsed.data.subjectKind,
          subjectId: parsed.data.subjectId,
          decision: parsed.data.decision,
          decidedAt,
          note,
        }));
      } catch (err) {
        console.error('[brain-api] POST /feedback error:', err instanceof Error ? err.message : String(err));
        return c.json({ error: 'feedback write failed' }, 500);
      }
    }),
  );

  // ── GET /feedback ──────────────────────────────────────────────────────────────────────
  app.get('/feedback', (c) =>
    withDb((db) => {
      try {
        const rows = db.prepare(`
          SELECT id, subject_kind, subject_id, decision, decided_at, note
          FROM recommendation_feedback
          ORDER BY decided_at DESC, id DESC
        `).all() as FeedbackRow[];
        const feedback = FeedbackDecision.array().parse(rows.map(toFeedbackDecisionShape));
        return c.json({ feedback });
      } catch (err) {
        console.error('[brain-api] GET /feedback error:', err instanceof Error ? err.message : String(err));
        return c.json({ error: 'feedback read failed' }, 500);
      }
    }),
  );

  return app;
}
