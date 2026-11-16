// tests/unit/governor-blank-inputs.test.ts
//
// Audit 2026-11-12 HIGH #2 (`spine-a-debt-noi-blank-to-zero`): a blank Loan Balance / Debt Service /
// NOI cell on a LEVERED Property NOI row used to become a flagless $0, which falsely cleared the LTV
// and DSCR governor tiles (blank loan / blank debt service) or falsely breached DSCR (blank NOI).
// Pins: parse raises a warn flag per blank governor input on a levered row (never on a free-and-clear
// row), and dscrHeadroom / portfolioKpis.ltv / applyScenario fail closed on a flagged row. Synthetic
// fixtures only. No governor constant is read or changed here beyond the ratified values passed in.
import ExcelJS from 'exceljs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseWorkbook } from '../../server/workbook/parse';
import { slug, RATIFIED_GOVERNORS, type PortfolioSnapshot, type Property } from '@contracts/index';
import {
  GOVERNOR_INPUT_BLANK_FIELD,
  GOVERNOR_LENDER_NO_FIGURES_FIELD,
  BLANK_IN_WORKBOOK,
  blankGovernorInputs,
  governorFieldValue,
  incompleteGovernorRows,
} from '../../src/analytics/governor-inputs';
import { dscrHeadroom } from '../../src/analytics/governor-headroom';
import { applyScenario, portfolioKpis } from '../../src/analytics/engine';
import { evaluateConditions } from '../../src/analytics/conditions';
import { portfolioDebtLine, portfolioLtvSentence } from '../../server/ai/debt-basis-copy';
import { runTool } from '../../server/ai/tools';
import { respond } from '../../server/ai/respond';
import { briefDscrSummary } from '../../server/brief/run';
import { overviewTotalDebtSublabel } from '../../src/modules/debt/debt-sublabels';
import { propertyLtvLabel } from '../../src/analytics/debt-basis';
import { buildNoiReconcileInputs } from '../../server/warehouse/reconcile-noi';

// ── parse ─────────────────────────────────────────────────────────────────────────────────────
const LEV_OK = 'Fixture Levered Alpha';
const LEV_BLANK_LOAN = 'Fixture Levered Bravo';
const LEV_BLANK_DS = 'Fixture Levered Charlie';
const LEV_BLANK_NOI = 'Fixture Levered Delta';
const FREE = 'Fixture Free Echo';
const LEV_ZERO_DSCR = 'Fixture Levered Foxtrot';
const LEV_TYPED_ZERO_LOAN = 'Fixture Levered Golf';
const FREE_ZERO_LTV = 'Fixture Free Hotel';
const FREE_NA_LENDER = 'Fixture Free India';
const LENDER_NOTE_ONLY = 'Fixture Note Juliet';
const ZERO_LOAN_POS_DS = 'Fixture Levered Kilo';
const ZERO_DS_POS_LOAN = 'Fixture Levered Lima';

type Cell = number | string | Date | null;
// col: idx, name, type, sf, tenantCount, occ, acqDate, estValue100, oxfordOwnPct, oxfordValue,
//      grossIncome, expenses, noi, noiScenarioAdj, debtService, netCashFlow, capRate, dscr,
//      lender, loanBalance, ltv, valuePerSf, rentPerSf, equityInvested, cashOnCash, holdYrs
const row = (idx: number, name: string, o: { noi: Cell; ds: Cell; lender: Cell; loan: Cell; dscr: Cell; ltv: Cell; cap?: Cell; coc?: Cell }): Cell[] => [
  idx, name, 'Industrial', 10000, 1, 1, new Date('2020-01-01'), 2_000_000, 1, 2_000_000, 300_000, 100_000, o.noi, o.noi, o.ds, null,
  o.cap ?? null, o.dscr, o.lender, o.loan, o.ltv, null, null, 100000, o.coc ?? null, null,
];

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

async function parsed() {
  const wb = new ExcelJS.Workbook();
  const props = wb.addWorksheet('Property NOI');
  props.addRow(row(1, LEV_OK, { noi: 200_000, ds: 100_000, lender: 'Fixture Bank', loan: 800_000, dscr: 2, ltv: 0.4 }));
  props.addRow(row(2, LEV_BLANK_LOAN, { noi: 200_000, ds: 100_000, lender: 'Fixture Bank', loan: null, dscr: 2, ltv: null }));
  props.addRow(row(3, LEV_BLANK_DS, { noi: 200_000, ds: null, lender: 'Fixture Bank', loan: 900_000, dscr: null, ltv: 0.45, coc: 0.25 }));
  props.addRow(row(4, LEV_BLANK_NOI, { noi: null, ds: 100_000, lender: 'Fixture Bank', loan: 700_000, dscr: null, ltv: 0.35 }));
  props.addRow(row(5, FREE, { noi: null, ds: null, lender: null, loan: null, dscr: null, ltv: null }));
  // Blank NOI with the workbook DSCR formula evaluating to 0 over it (refute wf_fe0c7b48-326).
  props.addRow(row(6, LEV_ZERO_DSCR, { noi: null, ds: 100_000, lender: 'Fixture Bank', loan: 700_000, dscr: 0, ltv: 0.35, cap: 0, coc: 0 }));
  // Free and clear, but the LTV column formula reads 0 over the blank loan (refute wf_6550093a-baa).
  props.addRow(row(8, FREE_ZERO_LTV, { noi: 150_000, ds: null, lender: null, loan: null, dscr: null, ltv: 0 }));
  // Free and clear, with a placeholder lender cell.
  props.addRow(row(9, FREE_NA_LENDER, { noi: 150_000, ds: null, lender: 'N/A', loan: null, dscr: null, ltv: null }));
  // Free and clear with a free-text lender note and every debt cell blank (refute wf_406ad3ef-7de).
  props.addRow(row(10, LENDER_NOTE_ONLY, { noi: 150_000, ds: null, lender: 'Unlevered', loan: null, dscr: null, ltv: null }));
  // Typed $0 balance beside positive debt service, LTV formula reading 0 over it (refute wf_406ad3ef-7de).
  props.addRow(row(11, ZERO_LOAN_POS_DS, { noi: 200_000, ds: 150_000, lender: 'Fixture Bank', loan: 0, dscr: null, ltv: 0 }));
  // Typed $0 debt service beside a positive third-party loan, DSCR blank.
  props.addRow(row(12, ZERO_DS_POS_LOAN, { noi: 200_000, ds: 0, lender: 'Fixture Bank', loan: 500_000, dscr: null, ltv: 0.25 }));
  // Typed $0 balance contradicted by the row's own 60% LTV cell.
  props.addRow(row(7, LEV_TYPED_ZERO_LOAN, { noi: 200_000, ds: 100_000, lender: 'Fixture Bank', loan: 0, dscr: 2, ltv: 0.6 }));
  wb.addWorksheet('Master Tenant Rent Roll');
  wb.addWorksheet('Loan Index');
  wb.addWorksheet('Cash Balances');
  wb.addWorksheet('Insurance Renewals');
  wb.addWorksheet('Monthly Checklist');
  wb.addWorksheet('Assumptions');
  const dir = mkdtempSync(join(tmpdir(), 'parse-gov-blank-'));
  tempDirs.push(dir);
  const file = join(dir, 'fixture.xlsx');
  await wb.xlsx.writeFile(file);
  return parseWorkbook(file);
}

describe('parseWorkbook — blank governor inputs on a levered row (audit HIGH #2)', () => {
  it('flags each blank Loan Balance / Debt Service / NOI on a levered row, warn severity, on the property and in dataQuality', async () => {
    const { snapshot } = await parsed();
    const byId = new Map(snapshot.properties.map((p) => [p.id, p]));
    expect(blankGovernorInputs(byId.get(slug(LEV_OK))!)).toEqual([]);
    expect(blankGovernorInputs(byId.get(slug(LEV_BLANK_LOAN))!)).toEqual(['loanBalance']);
    expect(blankGovernorInputs(byId.get(slug(LEV_BLANK_DS))!)).toEqual(['debtService']);
    expect(blankGovernorInputs(byId.get(slug(LEV_BLANK_NOI))!)).toEqual(['noi']);
    const listed = snapshot.dataQuality.filter((f) => f.field === GOVERNOR_INPUT_BLANK_FIELD);
    expect(listed.map((f) => [f.entity, f.rawValue]).sort()).toEqual(
      [
        [slug(LEV_BLANK_DS), 'debtService'], [slug(LEV_BLANK_LOAN), 'loanBalance'], [slug(LEV_BLANK_NOI), 'noi'],
        [slug(LEV_ZERO_DSCR), 'noi'], [slug(LEV_TYPED_ZERO_LOAN), 'loanBalance'],
        [slug(ZERO_LOAN_POS_DS), 'loanBalance'], [slug(ZERO_DS_POS_LOAN), 'debtService'],
        [slug(FREE), 'noi'],
      ].sort(),
    );
    expect(listed.every((f) => f.severity === 'warn')).toBe(true);
  });

  it('flags a blank NOI on a FREE-AND-CLEAR row too: NOI blankness is independent of leverage (refute wf_2f05948b-aae)', async () => {
    const { snapshot } = await parsed();
    const p = snapshot.properties.find((x) => x.id === slug(FREE))!;
    expect(blankGovernorInputs(p)).toEqual(['noi']);
    expect(p.encumbered).toBe(false);
    const k = portfolioKpis(snapshot);
    expect(k.noi.prov.formula).toMatch(new RegExp(`blank NOI on .*${FREE}`));
    // The DSCR governor is unaffected by a blank NOI on a row with no debt service.
    expect(dscrHeadroom(snapshot.properties, RATIFIED_GOVERNORS.dscrFloor).incomplete.some((r) => r.id === slug(FREE))).toBe(false);
  });

  it('words the blank-NOI data-quality flag with no bound direction and no unconditional "scored conservatively" (refute wf_da5abccb-d31)', async () => {
    const { snapshot } = await parsed();
    const noiFlags = snapshot.dataQuality.filter((f) => f.field === GOVERNOR_INPUT_BLANK_FIELD && f.rawValue === 'noi');
    expect(noiFlags.length).toBeGreaterThan(0);
    for (const f of noiFlags) {
      expect(f.issue).not.toMatch(/lower bound|at least|understated|scored conservatively/);
      expect(f.issue).toMatch(/portfolio NOI excludes this row/);
    }
  });

  it('nulls a cash-on-cash cell computed over a blank Debt Service: it overstates the return (refute wf_c93c6154-6b8)', async () => {
    const { snapshot } = await parsed();
    const p = snapshot.properties.find((x) => x.id === slug(LEV_BLANK_DS))!;
    expect(blankGovernorInputs(p)).toEqual(['debtService']);
    expect(p.cashOnCash).toBeNull();
  });

  it('nulls a 0 cap-rate and cash-on-cash cell derived from a blank NOI (refute wf_2f05948b-aae)', async () => {
    const { snapshot } = await parsed();
    const p = snapshot.properties.find((x) => x.id === slug(LEV_ZERO_DSCR))!;
    expect(p.capRate).toBeNull();
    expect(p.cashOnCash).toBeNull();
  });

  it('nulls a 0 DSCR cell derived from a blank NOI, so Base never raises a fabricated 0.00x alert (refute wf_fe0c7b48-326)', async () => {
    const { snapshot } = await parsed();
    const p = snapshot.properties.find((x) => x.id === slug(LEV_ZERO_DSCR))!;
    expect(p.dscr).toBeNull();
    expect(p.ltv).toBe(0.35); // a non-zero ratio cell is evidence and is kept
    // Base path: per-property alerts read p.dscr directly.
    expect(evaluateConditions(snapshot).some((i) => i.entityId === p.id && /dscr/i.test(i.id))).toBe(false);
  });

  it('treats a typed $0 Loan Balance that its own LTV cell contradicts as unknown (refute wf_fe0c7b48-326)', async () => {
    const { snapshot } = await parsed();
    const p = snapshot.properties.find((x) => x.id === slug(LEV_TYPED_ZERO_LOAN))!;
    expect(blankGovernorInputs(p)).toEqual(['loanBalance']);
    expect(p.encumbered).toBe(true);
    expect(p.ltv).toBe(0.6);
  });

  it('never treats a 0 ratio cell or a placeholder lender as leverage evidence (refute wf_6550093a-baa)', async () => {
    const { snapshot } = await parsed();
    for (const name of [FREE_ZERO_LTV, FREE_NA_LENDER]) {
      const p = snapshot.properties.find((x) => x.id === slug(name))!;
      expect(blankGovernorInputs(p), name).toEqual([]);
      expect(p.encumbered, name).toBe(false);
    }
  });

  it('never treats lender text alone as leverage: a note with no debt figures gets an info note, not a blank flag (refute wf_406ad3ef-7de)', async () => {
    const { snapshot } = await parsed();
    const p = snapshot.properties.find((x) => x.id === slug(LENDER_NOTE_ONLY))!;
    expect(blankGovernorInputs(p)).toEqual([]);
    expect(p.encumbered).toBe(false);
    const note = snapshot.dataQuality.find((f) => f.entity === p.id && f.field === GOVERNOR_LENDER_NO_FIGURES_FIELD);
    expect(note?.severity).toBe('info');
    // A placeholder lender gets no note at all.
    const na = snapshot.properties.find((x) => x.id === slug(FREE_NA_LENDER))!;
    expect(snapshot.dataQuality.some((f) => f.entity === na.id && f.field === GOVERNOR_LENDER_NO_FIGURES_FIELD)).toBe(false);
  });

  it('treats a typed $0 balance beside positive debt service as unknown, and nulls its 0 LTV cell (refute wf_406ad3ef-7de)', async () => {
    const { snapshot } = await parsed();
    const p = snapshot.properties.find((x) => x.id === slug(ZERO_LOAN_POS_DS))!;
    expect(blankGovernorInputs(p)).toEqual(['loanBalance']);
    expect(p.ltv).toBeNull();
    const q = snapshot.properties.find((x) => x.id === slug(ZERO_DS_POS_LOAN))!;
    expect(blankGovernorInputs(q)).toEqual(['debtService']);
  });

  it('never flags the DEBT cells of a free-and-clear row (no lender, no DSCR/LTV cells) when they are blank', async () => {
    const { snapshot } = await parsed();
    const free = snapshot.properties.find((p) => p.id === slug(FREE))!;
    expect(blankGovernorInputs(free).filter((f) => f !== 'noi')).toEqual([]);
    expect(free.encumbered).toBe(false);
  });

  it('keeps a levered row with a blank loan balance encumbered (unknown balance, not free and clear)', async () => {
    const { snapshot } = await parsed();
    expect(snapshot.properties.find((p) => p.id === slug(LEV_BLANK_LOAN))!.encumbered).toBe(true);
  });
});

// ── analytics fail-closed ─────────────────────────────────────────────────────────────────────
const base = {
  index: 1, address: '1 Test Way', city: null, state: null, market: 'Columbus OH', type: 'Flex',
  sf: 10_000, tenantCount: 1, occPct: 1, acqDate: null, estValue100: 0, oxfordOwnPct: 1, oxfordValue: 2_000_000,
  grossIncome: 0, expenses: 0, noiScenarioAdj: 0, netCashFlow: 0, capRate: null, valuePerSf: null,
  rentPerSf: null, equityInvested: 0, cashOnCash: null, holdYrs: null, encumbered: true,
};
const blankFlag = (id: string, field: string) => ({ entity: id, field: GOVERNOR_INPUT_BLANK_FIELD, issue: 'blank', rawValue: field, severity: 'warn' as const });
const prop = (o: Partial<Property> & Pick<Property, 'id' | 'name' | 'noi' | 'debtService' | 'loanBalance'>, blanks: string[] = []): Property =>
  ({ ...base, dscr: null, ltv: null, lender: 'Fixture Bank', ...o, flags: blanks.map((f) => blankFlag(o.id, f)) }) as Property;

const ok = prop({ id: 'a', name: 'Alpha', noi: 300_000, debtService: 100_000, dscr: 3, loanBalance: 600_000, ltv: 0.3 });
// Blank NOI parsed as 0: the old path computed DSCR = 0 → a FALSE breach.
const blankNoi = prop({ id: 'b', name: 'Bravo', noi: 0, debtService: 100_000, loanBalance: 500_000 }, ['noi']);
// Blank debt service parsed as 0: the old path dropped it from the levered set → a FALSE clear.
const blankDs = prop({ id: 'c', name: 'Charlie', noi: 50_000, debtService: 0, loanBalance: 1_500_000 }, ['debtService']);
// Blank loan parsed as 0: the old path dropped its loan out of aggregate LTV → a FALSE clear.
const blankLoan = prop({ id: 'd', name: 'Delta', noi: 200_000, debtService: 100_000, dscr: 2, loanBalance: 0 }, ['loanBalance']);

function snap(properties: Property[]): PortfolioSnapshot {
  return {
    meta: { schemaVersion: '1.0.0', asOf: '2026-11-01', generatedAt: '2026-11-01T00:00:00.000Z', source: 'test', scenario: 'Base' },
    properties, leases: [], loans: [],
    cash: { asOf: '2026-11-01', totalCash: 0, activeEntities: 0, largestEntity: null, concentrationTopPct: null, cagr: null, entities: [], history: [] },
  } as unknown as PortfolioSnapshot;
}

function fullSnap(properties: Property[]): PortfolioSnapshot {
  return {
    ...snap(properties),
    assumptions: { activeScenario: 'Base', revenueFactor: 1, vacancyFactor: 1, exitCapFactor: 1, thresholds: { balloonAlertMonths: 18, concentrationYellow: 0.25, concentrationRed: 0.5 }, asOf: '2026-11-01' },
    insurance: [], deals: [], tasks: [], counterparties: [],
    renewalStages: {}, tenantNotes: {}, dealComps: {}, acquisitionInputs: {}, noiBudgets: {}, tenantArrears: {}, arBalances: [],
    quickbooks: null, governors: null, marketRents: {}, workbookTotals: { noi: null, value: null, rent: null }, dataQuality: [],
  } as unknown as PortfolioSnapshot;
}

describe('dscrHeadroom fails closed on a blank governor input', () => {
  it('does not report a false breach from a blank NOI', () => {
    const h = dscrHeadroom([ok, blankNoi], RATIFIED_GOVERNORS.dscrFloor);
    expect(h.portfolio).toBeNull();
    expect(h.breached).toBe(false);
    expect(h.incomplete).toEqual([{ id: 'b', name: 'Bravo', fields: ['noi'] }]);
  });

  it('does not report a false clear from a blank debt service', () => {
    const h = dscrHeadroom([ok, blankDs], RATIFIED_GOVERNORS.dscrFloor);
    expect(h.portfolio).toBeNull();
    expect(h.incomplete).toEqual([{ id: 'c', name: 'Charlie', fields: ['debtService'] }]);
  });

  it('ignores a blank NOI on a row whose debt service was ENTERED as 0: it never enters the aggregate (refute wf_fe0c7b48-326)', () => {
    const paidOff = prop({ id: 'f', name: 'Foxtrot', noi: 0, debtService: 0, loanBalance: 0 }, ['noi']);
    const h = dscrHeadroom([ok, paidOff], RATIFIED_GOVERNORS.dscrFloor);
    expect(h.incomplete).toEqual([]);
    expect(h.portfolio).toBeCloseTo(3, 10);
  });

  it('still names a known below-floor DSCR on a row with unknown debt service as weakest, and counts it (refute wf_406ad3ef-7de)', () => {
    const weak = prop({ id: 'w', name: 'Weak', noi: 110_000, debtService: 0, dscr: 1.1, loanBalance: 800_000 }, ['debtService']);
    const h = dscrHeadroom([ok, weak], RATIFIED_GOVERNORS.dscrFloor);
    expect(h.portfolio).toBeNull();
    expect(h.weakest).toEqual({ id: 'w', name: 'Weak', dscr: 1.1 });
    expect(h.weakestBelowFloor).toBe(true);
    expect(h.leveredCount).toBe(2);
  });

  it('ignores a blank loan balance (not a DSCR input) and stays complete otherwise', () => {
    const h = dscrHeadroom([ok, blankLoan], RATIFIED_GOVERNORS.dscrFloor);
    expect(h.incomplete).toEqual([]);
    expect(h.portfolio).toBeCloseTo(500 / 200, 10);
  });
});

describe('portfolioKpis.ltv fails closed on a blank loan balance', () => {
  it('returns a null aggregate LTV instead of a falsely low one', () => {
    const k = portfolioKpis(snap([ok, blankLoan]));
    expect(k.ltv.value).toBeNull();
    expect(k.ltv.prov.formula).toMatch(/incomplete/i);
  });

  it('is unchanged when no loan balance is blank', () => {
    const k = portfolioKpis(snap([ok, blankNoi]));
    expect(k.ltv.value).toBeCloseTo((600_000 + 500_000) / 4_000_000, 10);
  });

  it('marks totalDebt as a lower bound, and the AI LTV sentence says incomplete, when a loan is blank', () => {
    const k = portfolioKpis(snap([ok, blankLoan]));
    expect(k.totalDebt.value).toBe(600_000);
    expect(k.totalDebt.prov.confidence).toBe('derived');
    expect(k.totalDebt.prov.formula).toMatch(/lower bound/);
    expect(portfolioLtvSentence(k)).toMatch(/^Portfolio LTV incomplete \(blank Loan Balance on Delta\); property loan balances of at least/);
  });

  it('carries the incomplete rows structurally, and every AI / sublabel surface says incomplete or lower bound (refute wf_6550093a-baa)', () => {
    const dashed = { ...blankLoan, name: 'Delta — North' } as Property; // an em dash in a name must not break the disclosure
    const s = fullSnap([ok, dashed]);
    const k = portfolioKpis(s);
    expect(k.ltvIncomplete).toEqual([{ id: 'd', name: 'Delta — North', fields: ['loanBalance'] }]);
    expect(portfolioLtvSentence(k)).toMatch(/^Portfolio LTV incomplete \(blank Loan Balance on Delta — North\)/);
    const summary = runTool('get_portfolio_summary', s, {}).data as Record<string, unknown>;
    expect(summary['ltvIncomplete']).toEqual(['Delta — North']);
    expect(summary['totalDebt']).toMatch(/^at least /);
    const scen = runTool('run_scenario', s, { scenario: 'Downside' }).data as Record<string, unknown>;
    expect(scen['ltvIncomplete']).toEqual(['Delta — North']);
    expect(respond('give me an overview', s).answer).toMatch(/Debt at least .*LTV incomplete/);
    expect(overviewTotalDebtSublabel(k)).toMatch(/at least.*LTV incomplete/);
  });

  it('carries blank-NOI rows structurally to every text surface: AI summary, scenario, overview, brief (refute wf_2f05948b-aae)', () => {
    const s = fullSnap([ok, blankNoi]);
    const k = portfolioKpis(s);
    expect(k.noiIncomplete).toEqual([{ id: 'b', name: 'Bravo', fields: ['noi'] }]);
    const summary = runTool('get_portfolio_summary', s, {}).data as Record<string, unknown>;
    // No direction claim: a blank NOI may be negative (vacant row with carrying costs), so neither
    // "at least" nor "understated" is true in general (refute wf_c93c6154-6b8).
    expect(summary['noi']).toMatch(/incomplete: excludes blank NOI/);
    expect(summary['noi']).not.toMatch(/at least|lower bound/);
    expect(summary['weightedCapRate']).toMatch(/^incomplete: /);
    expect(summary['weightedCapRate']).not.toMatch(/understated/);
    expect(summary['noiIncomplete']).toEqual(['Bravo']);
    expect((runTool('run_scenario', s, { scenario: 'Downside' }).data as Record<string, unknown>)['noiIncomplete']).toEqual(['Bravo']);
    expect(respond('give me an overview', s).answer).toMatch(/NOI \$\S+ excluding blank NOI on Bravo, weighted cap incomplete/);
    expect(respond('give me an overview', s).answer).not.toMatch(/NOI at least/);
  });

  it('a blank workbook NOI is missing-from-workbook in the Spine A/B tie-out, never a real $0 (refute wf_2f05948b-aae)', () => {
    const inputs = buildNoiReconcileInputs(fullSnap([ok, blankNoi]), [], []);
    expect(inputs.find((i) => i.propertyName === 'Bravo')!.workbookOxfordNoi).toBeNull();
    expect(inputs.find((i) => i.propertyName === 'Alpha')!.workbookOxfordNoi).toBe(300_000);
  });

  it('names incomplete rows in the daily-brief DSCR line instead of silently dropping them (refute wf_6550093a-baa)', () => {
    expect(briefDscrSummary([ok, blankNoi])).toBe('min 3.00x · incomplete: blank NOI on 1 row');
    expect(briefDscrSummary([ok])).toBe('min 3.00x');
  });

  it('classifies an affiliate-lender row with a blank balance as an affiliate note per property too: no false 65% alert (refute wf_c93c6154-6b8)', () => {
    const aff = prop({ id: 'e2', name: 'Echo Two', lender: 'Oxford Capital', noi: 50_000, debtService: 50_000, dscr: 4, loanBalance: 0, ltv: 0.7 }, ['loanBalance']);
    const s = fullSnap([ok, aff]);
    expect(evaluateConditions(s).some((i) => i.entityId === 'e2' && /^ltv/.test(i.id))).toBe(false);
    expect(propertyLtvLabel(aff)).toBe('affiliate note');
    const rows = runTool('get_property', s, { query: 'echo two' }).data as Array<Record<string, unknown>>;
    expect(rows[0]!['affiliateNote']).toBe(true);
  });

  it('carries a blank affiliate balance to every affiliate-notes disclosure: never dropped, never printed as exact (refute wf_da5abccb-d31)', () => {
    const aff = prop({ id: 'e', name: 'Echo', lender: 'Oxford Capital', noi: 50_000, debtService: 20_000, loanBalance: 0 }, ['loanBalance']);
    const k = portfolioKpis(snap([ok, aff]));
    expect(k.affiliateIncomplete).toEqual([{ id: 'e', name: 'Echo', fields: ['loanBalance'] }]);
    // Sign-agnostic affiliate basis: incomplete, never a "lower bound" (refute wf_d7665e23-135).
    expect(k.affiliateDebt.prov.formula).toBe('incomplete: blank Loan Balance on Echo');
    // The only affiliate note is blank: affiliateDebt is 0, yet the disclosure must not vanish.
    expect(overviewTotalDebtSublabel(k)).toMatch(/^affiliate notes: balance blank on Echo/);
    expect(portfolioDebtLine(k)).toMatch(/affiliate notes excluded \(balance blank on Echo\)/);
    expect(portfolioLtvSentence(k)).toMatch(/affiliate notes excluded \(balance blank on Echo\)/);
    const summary = runTool('get_portfolio_summary', fullSnap([ok, aff]), {}).data as Record<string, unknown>;
    expect(summary['affiliateNotesExcluded']).toBe('balance blank on Echo');
    expect(summary['affiliateIncomplete']).toEqual(['Echo']);
    // A known affiliate note beside the blank one: the amount is shown, marked incomplete.
    const aff2 = prop({ id: 'f', name: 'Foxtrot', lender: 'Oxford Capital', noi: 50_000, debtService: 20_000, loanBalance: 250_000 });
    const k2 = portfolioKpis(snap([ok, aff, aff2]));
    expect(overviewTotalDebtSublabel(k2)).toMatch(/^\+\$250K affiliate notes \(incomplete: balance blank on Echo\)/);
    // Complete: unchanged wording, no incomplete marker.
    const k3 = portfolioKpis(snap([ok, aff2]));
    expect(k3.affiliateIncomplete ?? []).toEqual([]);
    expect(overviewTotalDebtSublabel(k3)).toMatch(/^\+\$250K affiliate notes · /);
    expect(portfolioDebtLine(k3)).toMatch(/\+\$250K affiliate notes excluded\.$/);
  });

  it('dscrHeadroom exposes its levered set (levered + unknown-DS rows) so the tile caveat counts the same rows (refute wf_da5abccb-d31)', () => {
    const unknownDs = prop({ id: 'u', name: 'Uniform', noi: 80_000, debtService: 0, loanBalance: 400_000 }, ['debtService']);
    const h = dscrHeadroom([ok, unknownDs], RATIFIED_GOVERNORS.dscrFloor);
    expect(h.leveredIds).toEqual(['a', 'u']);
    expect(h.leveredCount).toBe(h.leveredIds.length);
  });

  it('ignores a blank balance on an affiliate-lender row: that note is excluded from LTV anyway (refute wf_fe0c7b48-326)', () => {
    const aff = prop({ id: 'e', name: 'Echo', lender: 'Oxford Capital', noi: 50_000, debtService: 20_000, loanBalance: 0 }, ['loanBalance']);
    const k = portfolioKpis(snap([ok, aff]));
    expect(k.ltv.value).toBeCloseTo(600_000 / 4_000_000, 10);
    expect(k.totalDebt.prov.confidence).toBe('confirmed');
  });

  it('marks portfolio NOI and weighted cap rate incomplete (derived) when an investment row has a blank NOI (refute wf_406ad3ef-7de)', () => {
    const k = portfolioKpis(snap([ok, blankNoi]));
    expect(k.noi.prov.confidence).toBe('derived');
    expect(k.noi.prov.formula).toMatch(/incomplete: excludes blank NOI on Bravo/);
    expect(k.noi.prov.formula).not.toMatch(/lower bound/);
    expect(k.weightedCapRate.prov.formula).toMatch(/incomplete: blank NOI on Bravo/);
    expect(portfolioKpis(snap([ok])).noi.prov.confidence).toBe('confirmed');
  });

  it('debt-basis mirrors the governor blank-field constant it cannot import (circular-import guard)', async () => {
    const src = (await import('node:fs')).readFileSync(join(__dirname, '..', '..', 'src', 'analytics', 'debt-basis.ts'), 'utf8');
    expect(src).toContain(`const BLANK_FIELD = '${GOVERNOR_INPUT_BLANK_FIELD}';`);
  });

  it('per-property surfaces show a blank governor input as blank, never $0 (refute wf_406ad3ef-7de)', () => {
    expect(governorFieldValue(blankNoi, 'noi')).toBeNull();
    expect(governorFieldValue(ok, 'noi')).toBe(300_000);
    expect(BLANK_IN_WORKBOOK).toMatch(/blank in workbook/);
    const s = fullSnap([ok, blankNoi, blankLoan]);
    const rows = runTool('get_property', s, { query: 'bravo' }).data as Array<Record<string, unknown>>;
    expect(rows[0]!['noi']).toBe(BLANK_IN_WORKBOOK);
    expect(rows[0]!['governorInputsBlank']).toEqual(['noi']);
  });

  it('lists only loan-balance blanks for the LTV tile', () => {
    expect(incompleteGovernorRows([ok, blankNoi, blankLoan], ['loanBalance'])).toEqual([{ id: 'd', name: 'Delta', fields: ['loanBalance'] }]);
  });
});

describe('applyScenario never fabricates a DSCR or LTV from a blank input', () => {
  it('leaves DSCR null (not 0) under Downside when NOI or debt service is blank', () => {
    const out = applyScenario(snap([ok, blankNoi, blankDs]), 'Downside').properties;
    expect(out.find((p) => p.id === 'b')!.dscr).toBeNull();
    expect(out.find((p) => p.id === 'c')!.dscr).toBeNull();
    expect(out.find((p) => p.id === 'a')!.dscr).not.toBeNull();
  });

  it('keeps the workbook LTV cell (not a recompute from $0) under Downside when the loan balance is blank', () => {
    const out = applyScenario(snap([ok, { ...blankLoan, ltv: 0.25 }]), 'Downside').properties;
    expect(out.find((p) => p.id === 'd')!.ltv).toBe(0.25);
    expect(applyScenario(snap([ok, blankLoan]), 'Downside').properties.find((p) => p.id === 'd')!.ltv).toBeNull();
  });

  it('never drops a per-property governor alert under a stress scenario that Base fires (refute wf_fe0c7b48-326)', () => {
    // Blank debt service with a typed 1.05x DSCR cell; blank loan with a typed 80% LTV cell.
    const c = prop({ id: 'c2', name: 'Charlie Two', noi: 100_000, debtService: 0, dscr: 1.05, loanBalance: 900_000, ltv: 0.5 }, ['debtService']);
    const d = prop({ id: 'd2', name: 'Delta Two', noi: 200_000, debtService: 50_000, dscr: 2, loanBalance: 0, ltv: 0.8 }, ['loanBalance']);
    const s = fullSnap([c, d]);
    const ids = (x: PortfolioSnapshot) => new Set(evaluateConditions(x).filter((i) => i.category === 'debt').map((i) => i.id));
    const base = ids(s);
    expect([...base].some((id) => id.startsWith('dscr') && id.endsWith('c2'))).toBe(true);
    expect(base.has('ltv-d2')).toBe(true);
    // Only the alerts that rest on the BLANK input are pinned (c2's DSCR, d2's LTV): those keep the
    // unshocked workbook cell. Alerts on KNOWN inputs move with the scenario as before (an Upside value
    // lift can legitimately take c2's recomputed LTV under 40%).
    const blankBacked = [...base].filter((id) => (id.startsWith('dscr') && id.endsWith('c2')) || (id.startsWith('ltv') && id.endsWith('d2')));
    expect(blankBacked.length).toBe(2);
    for (const sc of ['Downside', 'Upside'] as const) {
      const stressed = ids(applyScenario(s, sc));
      for (const id of blankBacked) expect(stressed.has(id), `${sc} dropped ${id}`).toBe(true);
    }
  });

  it('keeps the blank-input flags through the scenario so the tiles still see them', () => {
    const out = applyScenario(snap([blankNoi]), 'Upside').properties;
    expect(blankGovernorInputs(out[0]!)).toEqual(['noi']);
  });
});
