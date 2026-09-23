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
import type { GovernorSet } from '../src/contracts/index';
import { loadGovernors, GOVERNOR_DEFAULTS } from './warehouse/governors';
import { fetchDealComps } from './ai/comps';
import { runAgent } from './ai/agent';
import { scanForConfidential } from './briefing/confidential';
import { searchDocuments, docStatus, warmDocIndex } from './sources/documents';
import { getMacro } from './macro/getMacro';
import { serverPort } from './config';
import { loadInboxState, runAlertAction } from './alerts/store';
import { AlertActionInput } from '../src/contracts/alerts';
import { openWarehouse } from './warehouse/db';
import type { WarehouseDb } from './warehouse/db';
import { warehouseRoutes } from './warehouse/api';
import { WAREHOUSE_SUB_ROUTERS } from './warehouse/sub-routers';
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
import { requestBoundary, allowedHosts, extraAllowedHostsFromEnv } from './host-guard';
import { accessAuthz, accessAuthzOptionsFromEnv } from './access-authz';
import { createRateLimiter, createConcurrencyLimiter } from './rate-limit';
import { startServer } from './startup';

const app = new Hono();
// Request boundary (OI-050, see host-guard.ts) — the check that actually REJECTS a request: Host must
// be this server's own loopback authority (defeats DNS rebinding, where a foreign page is same-origin
// to the browser and cors() never even runs), a present Origin must be same-machine (fail-closed, not
// merely un-CORSed), and every non-GET/HEAD/OPTIONS must carry X-ORA-Client (forces a preflight, which
// the localhost-only cors() below then refuses for a foreign page). Mounted FIRST — ahead of cors()
// and accessAuthz — and on /sse too, which lives outside /api/* but streams confidential state.
const boundary = requestBoundary({ allowedHosts: allowedHosts(serverPort(), extraAllowedHostsFromEnv(process.env)) });
app.use('/api/*', boundary);
app.use('/sse', boundary);
// Confidential data — only same-machine localhost origins may call the API (see cors-policy.ts).
// This sets the CORS response header; it does not block anything — the boundary above does.
app.use('/api/*', cors({ origin: isAllowedOrigin }));

// Application-level authorization (Eric Live Phase 2, W2). INERT by default: with ACCESS_REQUIRE
// unset this is a pass-through, so localhost development is completely unaffected. It is turned on
// for the tunnelled deployment, where loopback binding is no longer the security boundary and a
// verified Cloudflare Access assertion becomes the only thing standing in front of the warehouse.
//
// Mounted HERE, immediately after cors and BEFORE every app.route() below, so there is no route —
// present or future — that can run its handler ahead of the check. Adding routes above this line
// would silently exempt them.
app.use('/api/*', accessAuthz(accessAuthzOptionsFromEnv(process.env)));

// Consumption bounds (OI-090, OWASP LLM10 — see rate-limit.ts). The three routes below already cap
// each request; these cap how OFTEN they may be started and, for the SSE agent loop, how many may be
// open at once. Per-route mounts (not /api/*) because the limits differ, and a FRESH instance per
// mount because a shared one would count every route against a single bucket. Mounted after the
// boundary/cors/authz stack so a refused caller costs a 403, never a token; before the route
// registrations so a rejected request never reaches the handler that would spend the money.
// The /api/ai concurrency slot follows the SSE body (streamSSE returns before runAgent finishes).
//
// app.on(METHOD, …), NOT app.use(path, …): app.use is method-agnostic, so a request with the WRONG
// method (GET /api/ai, which no handler serves) would still run the limiter chain and then 404 —
// spending a token for free, and for HEAD (which Hono dispatches as GET and answers body-less, so
// the wrapped body is never read) pinning a concurrency slot until restart. Scoping the mount to
// the one method the route actually serves lets every other method fall straight through to the
// not-found handler with no token spent and no slot touched (server-rate-limit.test.ts proves it).
app.on(
  'POST',
  '/api/ai',
  createRateLimiter({ capacity: 10, refillIntervalMs: 60_000 }),
  createConcurrencyLimiter({ max: 3 }),
);
app.on('POST', '/api/actions/om-extract', createRateLimiter({ capacity: 5, refillIntervalMs: 60_000 }));
// 90/min, not 30: the Documents search box fetches on every keystroke (useDocSearch keys React Query on
// the raw query, no debounce), so one ~28-char phrase is ~26 requests and 30 would 429 the second phrase's
// final, most-relevant keystrokes. 90 survives realistic typing bursts while still bounding a runaway loop
// against the CPU/memory-bound local embedding search (~1.5/s sustained).
app.on('GET', '/api/documents/search', createRateLimiter({ capacity: 90, refillIntervalMs: 60_000 }));

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
// Design-parity engines (P2/P4/P5/P6) + brain/insights: sub-routers per the debt-api pattern.
// Mount list lives in warehouse/sub-routers.ts — shared with bake-warehouse.ts's
// inProcessResolver so the two never drift apart on what's mounted where (2026-08-21 fix).
for (const { prefix, factory } of WAREHOUSE_SUB_ROUTERS) {
  app.route(`/api/warehouse${prefix}`, factory(getWarehouse));
}

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
      // Uses generatedAt (the per-refresh ISO timestamp) as source_date — NOT meta.asOf, which
      // is the workbook's own "As of" dateline (OI-023), not a per-refresh timestamp. This sibling
      // call was missed when the occupancy/debt-snapshot calls below were fixed. Note: unlike
      // occupancy, property_insurance_policies is keyed on (property_id, policy_number,
      // effective_date) with INSERT OR REPLACE, not a per-refresh-date history table — this fix
      // doesn't create new accumulating rows, it corrects source_date provenance and fixes
      // dedupeLatest's tie-break for NULL-keyed rows (see insurance-analysis.ts).
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
  // is the workbook's own "As of" dateline (since OI-023; previously the static WORKBOOK_AS_OF
  // constant) and only moves on a workbook save (see occupancy.ts captureOccupancy for this trap).
  // Unresolved loans (collateralProperty null/blank/typo'd) are warned, never silently dropped.
  try {
    const snapshot = brain.getSnapshot();
    if (snapshot) {
      const db = getWarehouse();
      const validPropertyIds = new Set<string>(
        (db.prepare('SELECT id FROM property_master').all() as { id: string }[]).map((r) => r.id),
      );
      const { map, unresolved } = buildLoanPropertyMap(snapshot.loans, snapshot.properties, validPropertyIds);
      const snapshotDate = snapshot.meta.generatedAt.slice(0, 10);
      // No opts here — deliberately. This is the AUTOMATED reload path (fires on every workbook
      // refresh, unattended); it is exactly the untrusted producer writeDebtSnapshot's H2a
      // empty-set guard exists to catch (2026-07-24). allowEmptySupersede is reachable only from
      // POST /snapshot (debt-api.ts), a SUPERVISED write a human/caller explicitly confirms.
      //
      // Round-9 correction (fifth adversarial pass, two lenses independently, HIGH): this call
      // is now UNCONDITIONAL on the loans array — a `snapshot.loans.length > 0` pre-screen used
      // to sit here, and it silently swallowed the exact regression the guard exists to catch.
      // parseLoans is section-banner-driven: banner drift in the Loan Index tab makes it return
      // a plain [] while every OTHER tab parses fine, so the old screen skipped this entire
      // block — no refusal, no persisted staleness marker, no log line — and the frozen book
      // kept reporting clearedConservatively=true indefinitely. Routing the empty array THROUGH
      // writeDebtSnapshot lets the wouldTotallyEmpty guard refuse safely, persist the marker
      // (migration 026), and hit the ⛔ branch below. Never re-add a length pre-screen here.
      const result = writeDebtSnapshot(db, snapshot.loans, snapshotDate, map);
      if (unresolved.length > 0) {
        console.warn(
          `⚠ Debt snapshot: ${unresolved.length} borrower loan(s) unattributed (fill Loan Index col 11): ${unresolved.join(', ')}`,
        );
      }
      if (result.refusedEmptySupersede) {
        // Obs-3 (PR #233 residual #2): a refusal on this UNATTENDED path is not routine sync
        // noise — the debt book is now frozen at its prior state until a human resolves it, and
        // computePortfolioAggregateLtv is withholding its governor verdict (via the persisted
        // refusal marker, migration 026 — that part is automatic, not dependent on this log).
        // console.error + distinct prefix so log scans treat it as a failure.
        console.error(
          `⛔ DEBT SNAPSHOT WRITE REFUSED — book frozen at prior state; aggregate-LTV verdict withheld until resolved: ${result.errors.join('; ')}`,
        );
      } else if (result.degradedRows > 0) {
        // Round 10 (sixth adversarial pass): a DEGRADED write — per-loan inserts failed after
        // their prior rows were retired, so the book may have silently LOST rows — is the one
        // event class that destroys data rather than freezing it, and it was landing in the
        // generic warning below. Failure-level, same as a refusal; the persisted marker is
        // already withholding the governor verdict either way.
        console.error(
          `⛔ DEBT SNAPSHOT DEGRADED — ${result.degradedRows} loan upsert(s) failed, book may have lost rows; aggregate-LTV verdict withheld until a clean write: ${result.errors.join('; ')}`,
        );
      } else if (result.vanishedIds.length > 0) {
        // Round 19b (adversarial refute, HIGH — reproduced): the write that FIRST latches an
        // unexplained-vanish marker used to be completely silent here. It sets neither
        // refusedEmptySupersede nor degradedRows, and staleMarkerHeld only fires on LATER writes,
        // so damage day logged nothing at all and the only signal the operator ever got was the
        // next reload's generic "STILL DEGRADED" — which never names the loan that disappeared.
        // Failure-level, and it names the ids, because this is the one moment someone can still
        // go look at the workbook and see what happened.
        console.error(
          `⛔ DEBT SNAPSHOT — LOANS VANISHED — ${result.vanishedIds.length} previously-active loan(s) disappeared ` +
            `with no terminal status and no same-property replacement: ${result.vanishedIds.join(', ')}. ` +
            'Governor verdicts are withheld until each returns or is confirmed gone ' +
            '(POST /api/warehouse/debt/snapshot with { confirmAbsent: [...] }).',
        );
      } else if (result.staleMarkerHeld) {
        // Round 13 (ninth adversarial pass, LOW): a clean write that fails to recover the
        // trusted book re-upserts the standing DEGRADED marker but used to return a fully-quiet
        // result — so the unattended path logged nothing for the entire damaged window after
        // damage day, making a weeks-long unnoticed freeze realistic. Failure-level, every
        // reload, until the book actually recovers.
        console.error(
          '⛔ DEBT BOOK STILL DEGRADED — trusted loans are still missing; aggregate-LTV verdict remains withheld (see the persisted marker for the missing ids).',
        );
      } else if (result.errors.length > 0) {
        // Generic label (2026-07-24, matching debt-api.ts's POST /snapshot twin): errors[] still
        // carries several classes — FK-validation backstops, unrecognized loan statuses, id
        // collisions. REFUSED/DEGRADED messages never land here (dedicated branches above).
        console.warn(
          `⚠ Debt snapshot: ${result.errors.length} writeDebtSnapshot warning(s)/error(s): ${result.errors.join('; ')}`,
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
    ai: { configured: !!process.env.ANTHROPIC_API_KEY, model: process.env.ANTHROPIC_MODEL ?? 'claude-opus-5' },
    brief: briefHealth,
  });
});

/**
 * Ratified governor set for the client alert engine (I10) — warehouse-fresh when the sqlite is
 * reachable; the compile-time GOVERNOR_DEFAULTS otherwise (identical unless a DB-only
 * re-ratification has landed). Fail-open: governor attach must never 503 the snapshot.
 * existsSync-gated (refute finding): getWarehouse() would otherwise CREATE + migrate a stray DB
 * as a side effect of a GET on cold/mirror machines. Defaults are logged ONCE, not silently —
 * a post-re-ratification regression to defaults must be observable in the server log.
 */
let governorFallbackWarned = false;
function liveGovernors(): GovernorSet {
  try {
    const dbPath = process.env.WAREHOUSE_DB ?? join(process.cwd(), 'data', 'warehouse', 'finance.sqlite');
    if (!existsSync(dbPath)) throw new Error(`warehouse absent at ${dbPath}`);
    const g = loadGovernors(getWarehouse());
    return { dscrFloor: g.dscrFloor, ltvCeiling: g.ltvCeiling, hurdleRatePct: g.hurdleRatePct, hurdleRateRatification: g.hurdleRateRatification, version: g.version, effectiveFrom: g.effectiveFrom };
  } catch (err) {
    if (!governorFallbackWarned) {
      governorFallbackWarned = true;
      console.warn(`[governors] warehouse unavailable — serving compile-time defaults (v${GOVERNOR_DEFAULTS.version}): ${err instanceof Error ? err.message : String(err)}`);
    }
    const d = GOVERNOR_DEFAULTS;
    return { dscrFloor: d.dscrFloor, ltvCeiling: d.ltvCeiling, hurdleRatePct: d.hurdleRatePct, hurdleRateRatification: d.hurdleRateRatification, version: d.version, effectiveFrom: d.effectiveFrom };
  }
}

/** The single typed payload: snapshot + live meta. */
app.get('/api/snapshot', (c) => {
  const snapshot = brain.getSnapshot();
  if (!snapshot) return c.json({ error: 'no snapshot available', state: brain.getState() }, 503);
  return c.json({ snapshot: { ...snapshot, governors: liveGovernors() }, state: brain.getState() });
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

  // Resolve the deal BEFORE extraction (previously only looked up after, for the save step) so a
  // confidential deal's OM text can be blocked pre-egress, before it ever reaches the Anthropic API.
  // No dealId (blank-deal upload) means nothing to check against — extraction proceeds as today.
  // A dealId that fails to resolve (snapshot unavailable / unknown id) is a DIFFERENT case — that
  // fails closed via dealLookupFailed below rather than silently proceeding as non-confidential.
  const dealId = form.get('dealId');
  const hasDealId = typeof dealId === 'string' && dealId !== '';
  const deal = hasDealId ? brain.getSnapshot()?.deals.find((d) => d.id === dealId) : undefined;

  const buf = Buffer.from(await file.arrayBuffer());
  const result = await extractOmFields(buf, {
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: process.env.OM_EXTRACT_MODEL ?? 'claude-haiku-4-5-20251001', // separate from ANTHROPIC_MODEL (the assistant model)
    dealConfidential: deal?.confidential,
    dealLookupFailed: hasDealId && !deal,
  });
  if (!result.ok) return c.json({ ok: false, error: result.error }, result.status as 403 | 422 | 500 | 502 | 503);

  // If a dealId is provided, save the PDF into the deal's Investment Candidates subfolder.
  let savedPath: string | undefined;
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
      // Governor attach (refute finding): the agent's get_alerts tool runs evaluateConditions —
      // without this it would use the compile-time fallback and diverge from the dashboard
      // after a DB-only re-ratification.
      snapshot: { ...snapshot, governors: liveGovernors() },
      apiKey: process.env.ANTHROPIC_API_KEY,
      model: process.env.ANTHROPIC_MODEL,
      effort: process.env.ANTHROPIC_EFFORT as 'low' | 'medium' | 'high' | 'max' | undefined,
      signal: ac.signal,
      docSearch: searchDocuments,
      macroProvider: getMacro,
      // OI-225 layer 2. Server-only: scanForConfidential reads the roster off disk, so it cannot be
      // imported into the runtime-agnostic agent module (the mirror has no filesystem) — it is
      // injected here instead. Evaluated per tool result rather than hoisted, so a roster edit takes
      // effect without a restart. If the roster is absent/unreadable, loadTerms THROWS by design and
      // runAgent's catch re-emits e.message verbatim as an SSE error event: a confidentiality gate
      // fails closed, but that raw message embeds the roster's absolute filesystem path and the
      // ALLOW_PLACEHOLDER opt-out's name (refute finding, LOW) — fine on stderr, not fine streamed to
      // whatever is reading the browser's network tab. Catch here, log the real detail server-side,
      // and re-throw a generic message; the fail-closed behavior (still throws, still halts) and the
      // documented CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER=1 opt-out are both unchanged.
      confidentialScan: (value) => {
        try {
          return scanForConfidential(value);
        } catch (err) {
          console.error('[ai] confidentiality guard unavailable:', err);
          throw new Error('Confidentiality guard unavailable — refusing to send.');
        }
      },
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
  startServer({
    listen: (onListening) => {
      serve({ fetch: app.fetch, port: serverPort(), hostname: '127.0.0.1' }, (info) => {
        onListening(info.port);
        console.log(`  Workbook: ${brain.getState().workbookPath}`);
      });
    },
    refresh: () => brain.refresh('startup').then(() => { brain.startWatching(); }),
    warmDocs: () => warmDocIndex(),
    log: (m) => console.log(m),
    warn: (m, err) => console.error(m, err),
  });
}

void main();
