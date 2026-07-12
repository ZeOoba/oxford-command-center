import { loadEnvFile } from './load-env';

// Load .env with override-on-empty BEFORE anything reads process.env (node's --env-file won't
// override an already-present empty var — see load-env.ts).
loadEnvFile();

import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import { brain } from './brain';
import { DealStage, RenewalStageInput, NoiBudgetInput, AcquisitionInput, TenantArrearsInput } from '../src/contracts/index';
import { DealCompsActionInput } from '../src/contracts/index';
import { fetchDealComps } from './ai/comps';
import { runAgent } from './ai/agent';
import { searchDocuments, docStatus, warmDocIndex } from './sources/documents';
import { getMacro } from './macro/getMacro';
import { serverPort } from './config';
import { loadInboxState, runAlertAction } from './alerts/store';
import { AlertActionInput } from '../src/contracts/alerts';
import { openWarehouse } from './warehouse/db';
import type { WarehouseDb } from './warehouse/db';
import { warehouseRoutes } from './warehouse/api';
import { debtApi } from './warehouse/debt-api';
import { leaseForecastApi } from './warehouse/lease-forecast-api';
import { capitalAllocationApi } from './warehouse/capital-allocation-api';
import { insuranceAnalysisApi } from './warehouse/insurance-analysis-api';
import { insuranceLossApi } from './warehouse/insurance-loss-api';
import { taxApi } from './warehouse/tax-api';
import { brainApi } from './warehouse/brain-api';
import { insightsApi } from './warehouse/insights-api';
import { onboardProperty, PropertyOnboardingInputSchema } from './warehouse/property-onboarding';
import type { PropertyOnboardingInput } from './warehouse/property-onboarding';
import { MarketRentInput } from '../src/contracts/lease-forecast';
import { writeDebtSnapshot } from './warehouse/debt-snapshot';
import { buildLoanPropertyMap } from './warehouse/property-crosswalk';
import { captureOccupancy } from './warehouse/occupancy';
import { captureInsurance, snapshotPoliciesToWarehouse } from './warehouse/insurance';
import { extractOmFields } from './warehouse/om-extract';
import { listLeaseTermPropertyIds } from './warehouse/lease-terms';
import { setLeaseRunAssumptions } from './overlay';
import { LeaseRunAssumptionsInput } from '../src/contracts/lease-run';
import { isAllowedOrigin } from './cors-policy';

const app = new Hono();
// Confidential data — only same-machine localhost origins may call the API (see cors-policy.ts).
app.use('/api/*', cors({ origin: isAllowedOrigin }));

// Property Financial Intelligence warehouse — opened lazily as a process singleton on
// first /api/warehouse/* request (not at boot: a cold/mirror env may lack the sqlite
// file, and the warehouse must never block the rest of the server from serving). The
// getter throws on an unopenable path; warehouseRoutes catches that and returns 503.
let _warehouse: WarehouseDb | null = null;
function getWarehouse(): WarehouseDb {
  if (_warehouse) return _warehouse;
  const path = process.env.WAREHOUSE_DB ?? join(process.cwd(), 'data', 'warehouse', 'finance.sqlite');
  _warehouse = openWarehouse(path);
  return _warehouse;
}
app.route('/api/warehouse', warehouseRoutes(getWarehouse));
app.route('/api/warehouse/debt', debtApi(getWarehouse));
app.route('/api/warehouse/leasing', leaseForecastApi(getWarehouse));
app.route('/api/warehouse/capital', capitalAllocationApi(getWarehouse));
// Design-parity engines (P2/P4/P5/P6): sub-routers per the debt-api pattern.
app.route('/api/warehouse/insurance/analysis', insuranceAnalysisApi(getWarehouse));
app.route('/api/warehouse/insurance/loss', insuranceLossApi(getWarehouse));
app.route('/api/warehouse/tax', taxApi(getWarehouse));
app.route('/api/warehouse/brain', brainApi(getWarehouse));
app.route('/api/warehouse/insights', insightsApi(getWarehouse));

// POST /api/warehouse/properties/onboard — data-driven property onboarding (Phase 5 W4)
app.post('/api/warehouse/properties/onboard', async (c) => {
  let db: WarehouseDb;
  try { db = getWarehouse(); }
  catch { return c.json({ ok: false, error: 'warehouse unavailable' }, 503); }
  let body: PropertyOnboardingInput;
  try {
    const parsed = PropertyOnboardingInputSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ ok: false, error: 'invalid request body' }, 400);
    body = parsed.data;
  } catch { return c.json({ ok: false, error: 'invalid request body' }, 400); }
  try {
    const result = onboardProperty(db, body);
    return c.json(result, result.ok ? 200 : 400);
  } catch {
    return c.json({ ok: false, error: 'onboarding failed' }, 500);
  }
});

// Occupancy time-series capture: on every workbook-sourced refresh (startup, file-change,
// api/manual — NOT overlay edits or a failed-parse fallback), snapshot each property's occPct
// into the warehouse so occupancy history accumulates automatically. Fully guarded: a missing/
// unopenable warehouse must never break the brain refresh or the SSE push.
brain.on('snapshot', (info: unknown) => {
  const reason = (info as { reason?: string } | undefined)?.reason ?? '';
  if (reason.startsWith('action:') || reason.endsWith(':fallback')) return;
  try {
    captureOccupancy(getWarehouse(), brain.getSnapshot());
  } catch (err) {
    // Warehouse unavailable (cold/mirror env) — capture is best-effort, but do not fail SILENTLY:
    // a total capture failure must be observable in the server log, not invisible.
    console.warn('⚠ Occupancy capture skipped:', err instanceof Error ? err.message : String(err));
  }
  try {
    const snapshot = brain.getSnapshot();
    if (snapshot) {
      // Uses generatedAt (the per-refresh ISO timestamp) as the source date — NOT meta.asOf,
      // which is the static WORKBOOK_AS_OF constant (see occupancy.ts:169-171 for this trap).
      // This sibling call was missed when the occupancy/debt-snapshot calls below were fixed —
      // every refresh was overwriting the same '2026-06-01' row instead of accumulating history.
      captureInsurance(
        getWarehouse(),
        snapshotPoliciesToWarehouse(snapshot.insurance, snapshot.meta.generatedAt.slice(0, 10)),
      );
    }
  } catch (err) {
    console.warn('⚠ Insurance capture skipped:', err instanceof Error ? err.message : String(err));
  }
  // Debt snapshot: write borrower-side debt positions to the warehouse on every workbook refresh.
  // Uses generatedAt (the per-refresh ISO timestamp) as the snapshot_date — NOT meta.asOf, which
  // is the static WORKBOOK_AS_OF constant '2026-06-01' (see occupancy.ts:169-171 for this trap).
  // Unresolved loans (collateralProperty null/blank/typo'd) are warned, never silently dropped.
  try {
    const snapshot = brain.getSnapshot();
    if (snapshot && snapshot.loans.length > 0) {
      const db = getWarehouse();
      const validPropertyIds = new Set<string>(
        (db.prepare('SELECT id FROM property_master').all() as { id: string }[]).map((r) => r.id),
      );
      const { map, unresolved } = buildLoanPropertyMap(snapshot.loans, snapshot.properties, validPropertyIds);
      const snapshotDate = snapshot.meta.generatedAt.slice(0, 10);
      const result = writeDebtSnapshot(db, snapshot.loans, snapshotDate, map);
      if (unresolved.length > 0) {
        console.warn(
          `⚠ Debt snapshot: ${unresolved.length} borrower loan(s) unattributed (fill Loan Index col 11): ${unresolved.join(', ')}`,
        );
      }
      if (result.errors.length > 0) {
        console.warn(
          `⚠ Debt snapshot: ${result.errors.length} FK-validation error(s) (belt-and-suspenders backstop): ${result.errors.join('; ')}`,
        );
      }
    }
  } catch (err) {
    console.warn('⚠ Debt snapshot skipped:', err instanceof Error ? err.message : String(err));
  }
});

app.get('/api/health', (c) => {
  const briefHealth = existsSync('data/brief-health.json')
    ? (JSON.parse(readFileSync('data/brief-health.json', 'utf8')) as {
        ranAt: string;
        briefSent: boolean;
        alertsSent: number;
        failures: string[];
      })
    : null;
  return c.json({
    ok: true,
    service: 'oxford-brain-server',
    state: brain.getState(),
    // Surface AI availability WITHOUT exposing the key (no silent fallbacks — System Health shows it).
    ai: { configured: !!process.env.ANTHROPIC_API_KEY, model: process.env.ANTHROPIC_MODEL ?? 'claude-opus-4-8' },
    brief: briefHealth,
  });
});

/** The single typed payload: snapshot + live meta. */
app.get('/api/snapshot', (c) => {
  const snapshot = brain.getSnapshot();
  if (!snapshot) return c.json({ error: 'no snapshot available', state: brain.getState() }, 503);
  return c.json({ snapshot, state: brain.getState() });
});

app.post('/api/refresh', async (c) => {
  const state = await brain.refresh('api');
  return c.json({ state });
});

/**
 * Write-back actions (Phase 5) — persist to the local overlay; the workbook stays read-only.
 * Confirm-before-write happens in the UI. Available only on the live server (the mirror is read-only).
 */
app.post('/api/actions/deal-stage', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { dealId?: string; stage?: string };
  const stage = DealStage.safeParse(body.stage);
  if (!body.dealId || !stage.success) return c.json({ ok: false, error: 'Invalid dealId or stage' }, 400);
  const ok = brain.setDealStage(body.dealId, stage.data);
  return c.json({ ok, state: brain.getState() }, ok ? 200 : 404);
});

app.post('/api/actions/task', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    label?: string; section?: string; type?: string; dueDay?: string; notes?: string;
  };
  const label = String(body.label ?? '').trim();
  if (!label) return c.json({ ok: false, error: 'label required' }, 400);
  brain.addTask({
    id: `usr-${Date.now()}-${Math.round(Math.random() * 1e6)}`,
    label,
    section: String(body.section ?? 'Added in Command Center'),
    role: null,
    type: body.type ?? 'Manual',
    dueDay: body.dueDay ?? null,
    notes: body.notes ?? null,
    status: 'pending',
    monthlyPmt: null,
  });
  return c.json({ ok: true, state: brain.getState() });
});

app.get('/api/alerts/state', (c) => c.json(loadInboxState()));

app.post('/api/actions/alert', async (c) => {
  const parsed = AlertActionInput.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ ok: false, error: 'Invalid alert action' }, 400);
  const state = runAlertAction(parsed.data);
  return c.json({ ok: true, state });
});

app.post('/api/actions/renewal-stage', async (c) => {
  const parsed = RenewalStageInput.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ ok: false, error: 'Invalid leaseId or stage' }, 400);
  const ok = brain.setRenewalStage(parsed.data.leaseId, parsed.data.stage);
  return c.json({ ok, state: brain.getState() }, ok ? 200 : 404);
});

app.post('/api/actions/tenant-note', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { tenantId?: string; note?: string };
  const tenantId = String(body.tenantId ?? '').trim();
  if (!tenantId) return c.json({ ok: false, error: 'tenantId required' }, 400);
  const ok = brain.setTenantNote(tenantId, String(body.note ?? ''));
  return c.json({ ok, state: brain.getState() }, ok ? 200 : 404);
});

app.post('/api/actions/deal-comps', async (c) => {
  const parsed = DealCompsActionInput.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ ok: false, error: 'Invalid dealId' }, 400);
  const snapshot = brain.getSnapshot();
  const deal = snapshot?.deals.find((d) => d.id === parsed.data.dealId);
  if (!deal) return c.json({ ok: false, error: 'Unknown deal' }, 404);
  const result = await fetchDealComps(deal, {
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: process.env.ANTHROPIC_MODEL,
    now: new Date().toISOString(),
  });
  if (!result.ok) return c.json({ ok: false, error: result.error }, 502);
  brain.setDealComps(deal.id, result.comps);
  return c.json({ ok: true, comps: result.comps });
});

app.post('/api/actions/noi-budget', async (c) => {
  const parsed = NoiBudgetInput.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ ok: false, error: 'Invalid propertyId or amount' }, 400);
  const ok = brain.setNoiBudget(parsed.data.propertyId, parsed.data.amount);
  return c.json({ ok, state: brain.getState() }, ok ? 200 : 404);
});

app.post('/api/actions/market-rent', async (c) => {
  const parsed = MarketRentInput.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ ok: false, error: 'Invalid key or rentPsf' }, 400);
  const ok = brain.setMarketRent(parsed.data.key, parsed.data.rentPsf);
  return c.json({ ok }, ok ? 200 : 503);
});

app.post('/api/actions/acquisition-input', async (c) => {
  const parsed = AcquisitionInput.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ ok: false, error: 'Invalid acquisition input' }, 400);
  const ok = brain.setAcquisitionInput(parsed.data.dealId, parsed.data);
  return c.json({ ok, state: brain.getState() }, ok ? 200 : 404);
});

app.post('/api/actions/tenant-arrears', async (c) => {
  const parsed = TenantArrearsInput.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ ok: false, error: 'Invalid leaseId or arrears' }, 400);
  const ok = brain.setTenantArrears(parsed.data.leaseId, parsed.data.arrears);
  return c.json({ ok, state: brain.getState() }, ok ? 200 : 404);
});

app.post('/api/actions/om-extract', async (c) => {
  const MAX_BYTES = 25 * 1024 * 1024; // 25 MB
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ ok: false, error: 'Expected multipart/form-data with a PDF file.' }, 400);
  }
  const file = form.get('file');
  if (!(file instanceof File)) {
    return c.json({ ok: false, error: 'No file field in request.' }, 400);
  }
  if (!file.name.toLowerCase().endsWith('.pdf')) {
    return c.json({ ok: false, error: 'Only PDF files are supported.' }, 400);
  }
  if (file.size > MAX_BYTES) {
    return c.json({ ok: false, error: 'File too large (max 25 MB).' }, 413);
  }
  const buf = Buffer.from(await file.arrayBuffer());
  const result = await extractOmFields(buf, {
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: process.env.OM_EXTRACT_MODEL ?? 'claude-haiku-4-5-20251001', // separate from ANTHROPIC_MODEL (the assistant model)
  });
  if (!result.ok) return c.json({ ok: false, error: result.error }, result.status as 422 | 500 | 502 | 503);

  // If a dealId is provided, save the PDF into the deal's Investment Candidates subfolder.
  let savedPath: string | undefined;
  const dealId = form.get('dealId');
  if (typeof dealId === 'string' && dealId) {
    const snapshot = brain.getSnapshot();
    const deal = snapshot?.deals.find((d) => d.id === dealId);
    if (deal && process.env.DOCUMENTS_DIR) {
      const year = new Date().getFullYear();
      // eslint-disable-next-line no-control-regex -- intentional: strip Windows-reserved chars + ASCII control range (\x00-\x1f) from uploaded filenames
      const safeFileName = basename(file.name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
      const dealDir = join(process.env.DOCUMENTS_DIR, `Investment Candidates -- ${year}`, `${deal.name} — ${deal.location}`);
      try {
        await mkdir(dealDir, { recursive: true });
        const outPath = resolve(join(dealDir, safeFileName));
        if (!outPath.startsWith(resolve(dealDir) + sep)) throw new Error('path traversal');
        await writeFile(outPath, buf);
        savedPath = dealDir;
      } catch {
        // save is best-effort — extraction already succeeded
      }
    }
  }

  return c.json({ ok: true, fields: result.fields, fieldCount: result.fieldCount, ...(result.rawText ? { rawText: result.rawText } : {}), ...(savedPath ? { savedPath } : {}) });
});

// Lease-run assumption override (confirm-before-write). Persists a per-property partial to the
// overlay (data/overlay.json), merged onto the spec defaults by the engine. 404 when the property
// has no lease terms; 503 when the warehouse is cold (so we can't validate the property). Purely
// additive — touches no governor and no existing overlay behavior.
app.post('/api/actions/lease-run-assumptions', async (c) => {
  const parsed = LeaseRunAssumptionsInput.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ ok: false, error: 'Invalid lease-run assumptions' }, 400);
  let known: string[];
  try {
    known = listLeaseTermPropertyIds(getWarehouse());
  } catch {
    return c.json({ ok: false, error: 'warehouse unavailable' }, 503);
  }
  if (!known.includes(parsed.data.propertyId)) {
    return c.json({ ok: false, error: 'Unknown lease-run property' }, 404);
  }
  const { propertyId, ...patch } = parsed.data;
  try {
    const assumptions = await setLeaseRunAssumptions(propertyId, patch);
    return c.json({ ok: true, propertyId, assumptions });
  } catch {
    return c.json({ ok: false, error: 'overlay persistence failed' }, 500);
  }
});

/** Macro indicators — live FRED when FRED_API_KEY is set, real-seeded snapshot otherwise. */
app.get('/api/macro', async (c) => c.json(await getMacro()));

/** Document RAG status — indexed lease/PSA/OM docs (server-only; empty until DOCUMENTS_DIR is set). */
app.get('/api/documents', async (c) => c.json(await docStatus()));

app.get('/api/documents/search', async (c) => {
  const q = c.req.query('q') ?? '';
  const limit = Math.min(20, Math.max(1, Number(c.req.query('limit') ?? 8) || 8));
  if (!q.trim()) return c.json({ hits: [] });
  const hits = await searchDocuments(q, limit);
  return c.json({ hits });
});

/**
 * AI assistant — a streaming, tool-using agent over the spine (server/ai/agent.ts).
 * Streams SSE frames: event `tool` (step), `text` (token delta), `done`, `error`.
 * Uses live Claude when ANTHROPIC_API_KEY is set; deterministic responder otherwise.
 */
app.post('/api/ai', (c) =>
  streamSSE(c, async (stream) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      question?: string;
      history?: Array<{ role: 'user' | 'assistant'; text: string }>;
    };
    const question = String(body.question ?? '');
    const history = Array.isArray(body.history) ? body.history : [];
    const snapshot = brain.getSnapshot();
    if (!snapshot) {
      await stream.writeSSE({ event: 'error', data: JSON.stringify({ type: 'error', message: 'Data is still loading — try again in a moment.' }) });
      return;
    }
    const ac = new AbortController();
    stream.onAbort(() => ac.abort());
    await runAgent({
      question,
      history,
      snapshot,
      apiKey: process.env.ANTHROPIC_API_KEY,
      model: process.env.ANTHROPIC_MODEL,
      effort: process.env.ANTHROPIC_EFFORT as 'low' | 'medium' | 'high' | 'max' | undefined,
      signal: ac.signal,
      docSearch: searchDocuments,
      macroProvider: getMacro,
      emit: async (e) => {
        await stream.writeSSE({ event: e.type, data: JSON.stringify(e) });
      },
    });
  }),
);

/** Live push: clients subscribe and refetch the snapshot when the workbook changes. */
app.get('/sse', (c) =>
  streamSSE(c, async (stream) => {
    let open = true;
    stream.onAbort(() => {
      open = false;
    });

    await stream.writeSSE({ event: 'state', data: JSON.stringify(brain.getState()) });

    const onState = (state: unknown) => {
      void stream.writeSSE({ event: 'state', data: JSON.stringify(state) });
    };
    const onSnapshot = (info: unknown) => {
      void stream.writeSSE({ event: 'snapshot', data: JSON.stringify(info) });
    };
    brain.on('state', onState);
    brain.on('snapshot', onSnapshot);

    try {
      while (open) {
        await stream.writeSSE({ event: 'heartbeat', data: String(Date.now()) });
        await stream.sleep(15_000);
      }
    } finally {
      brain.off('state', onState);
      brain.off('snapshot', onSnapshot);
    }
  }),
);

async function main() {
  // Bind the port FIRST — nothing should delay the server from accepting connections.
  // A slow or hanging workbook load (brain.refresh) previously blocked serve() from being called
  // for 5+ minutes on a cold start. All degraded-mode guards are already in place: /api/snapshot
  // 503s on null snapshot, warehouse opens lazily, /api/health stays live throughout.
  serve({ fetch: app.fetch, port: serverPort(), hostname: '127.0.0.1' }, (info) => {
    console.log(`◆ Oxford Brain Server — http://127.0.0.1:${info.port} (localhost only)`);
    console.log(`  Workbook: ${brain.getState().workbookPath}`);
  });
  // Load the workbook and start watching in the background — a slow/hanging read must never
  // block the port. /api/snapshot 503s gracefully until the refresh completes.
  brain.refresh('startup')
    .then(() => { brain.startWatching(); })
    .catch((err) => {
      console.error('⚠ Brain startup refresh failed — serving in degraded mode (snapshot 503 until workbook loads):', err);
    });
  // Warm the document RAG index in the BACKGROUND — a slow/hanging embedding-model load must never
  // block the server from binding the port. The warehouse + workbook-backed UI (incl. the three
  // server-only modules: acquisition scoring, PFI, calibration) do not depend on the doc index.
  warmDocIndex().catch((err) => {
    console.error('⚠ Document index warm-up failed (non-fatal):', err);
  });
}

void main();
