import { describe, it, expect } from 'vitest';
import { parseArAging, detectArFormat, isGarbageExtraction } from '../../server/ar/ar-aging';

// Synthetic fixtures — they mirror the REAL column structure of each PM export but use fake tenant
// names and numbers, so no real tenant delinquency data lives in the repo.

// Yardi "Aging Detail": detail rows start with the property code + carry a date; the per-tenant
// SUBTOTAL row is "<name> <Current> <0-30> <31-60> <61-90> <Over90> <Prepay> <Total>" (7 tokens).
const RENT_MANAGER_AGING = `Aging Detail Page 1
Property Customer Lease Status Tran# Charge Date Month Current 0-30 31-60 61-90 Over Pre- Total
demoinf (demoinf)
Acme Co (t0000001)
demoinf Acme Co Current C-1 GPRENT 05/01/2024 05/2024 100.00 100.00 0.00 0.00 0.00 0.00 100.00
Acme Co 100.00 100.00 0.00 0.00 0.00 0.00 100.00
Charlie Inc (t0000003)
demoinf Charlie Inc Current C-3 TAX-REC 02/01/2024 02/2024 10.00 20.00 30.00 40.00 50.00 0.00 140.00
Charlie Inc 10.00 20.00 30.00 40.00 50.00 -5.00 140.00
Delta Credit Co (t0000004)
demoinf Delta Credit Co Current R-9 Prepay 03/01/2024 03/2024 0.00 0.00 0.00 0.00 -100.00 0.00 -100.00
Delta Credit Co 0.00 0.00 0.00 0.00 -100.00 0.00 -100.00
demoinf 110.00 120.00 30.00 40.00 -50.00 -5.00 350.00
Grand Total 110.00 120.00 30.00 40.00 -50.00 -5.00 350.00`;

// AppFolio "Aged Receivable Detail": tenant identity is the unit header; the SUBTOTAL row is money
// tokens only (Amount, TotalReceivable, 0-30, 31-60, 61-90, 91+) — buckets are the LAST 4.
const APPFOLIO = `Aged Receivable Detail
Payer Name GL Account Name Total Amount 0-30 31-60 61-90 91+
demo-a - 100 Demo Drive Bldg A Townsville, MD 21801 - Unit 07A - Acme Service Co
Acme Service Co 08/01/2024 08/01/2024 38100000 Water 15.00 15.00 15.00 0.00 0.00 0.00
15.00 15.00 15.00 0.00 0.00 0.00
demo-b - 102 Demo Drive Bldg B Townsville, MD 21801 - Unit 01B - Bravo Tenant
Bravo Tenant 07/01/2024 07/01/2024 31100000 Rent 900.00 900.00 0.00 0.00 900.00 0.00
900.00 900.00 0.00 0.00 900.00 0.00
demo-b - 102 Demo Drive Bldg B Townsville, MD 21801 - Unit 04B - Echo Credit LLC
Echo Credit LLC 06/24/2024 06/24/2024 38600000 Clearing -1,998.00 -50.00 0.00 0.00 -50.00 0.00
-50.00 -50.00 0.00 0.00 -50.00 0.00
Total 865.00 865.00 15.00 0.00 850.00 0.00`;

const DELINQUENCY = `Delinquency (Detail)
All Properties
Current tenants as of 05/31/24
Tenant Name Acc Unit Unit Type Rent Amount Other Amount Charge Date Per Day Late
Acme Co 12345 2000 Comm 4,000.00 Rent Charge 4/1/24 0.00`;

describe('detectArFormat', () => {
  it('identifies each known format from the header', () => {
    expect(detectArFormat(RENT_MANAGER_AGING)).toBe('yardi-aging');
    expect(detectArFormat(APPFOLIO)).toBe('appfolio-aged-receivable');
    expect(detectArFormat(DELINQUENCY)).toBe('rent-manager-delinquency');
    expect(detectArFormat('some random text')).toBe('unknown');
  });
});

describe('parseArAging — Yardi Aging Detail', () => {
  const { format, rows } = parseArAging(RENT_MANAGER_AGING);
  it('detects the format', () => expect(format).toBe('yardi-aging'));

  it('maps 0-30/31-60/61-90/Over90 → d30/d60/d90/d90plus (skips Current, Prepay, Total)', () => {
    const charlie = rows.find((r) => r.tenant === 'Charlie Inc');
    expect(charlie).toBeDefined();
    expect(charlie).toMatchObject({ d30: 20, d60: 30, d90: 40, d90plus: 50 });
  });

  it('extracts one row per tenant subtotal, not per detail charge', () => {
    expect(rows.map((r) => r.tenant).sort()).toEqual(['Acme Co', 'Charlie Inc', 'Delta Credit Co']);
  });

  it('clamps a negative bucket (credit/prepayment) to 0', () => {
    const delta = rows.find((r) => r.tenant === 'Delta Credit Co');
    expect(delta).toMatchObject({ d30: 0, d60: 0, d90: 0, d90plus: 0 }); // Over90 was -100 → 0
  });

  it('does not emit the property-code total or the Grand Total line as a tenant', () => {
    // Both carry the WHOLE property's arrears — emitting them would inject a phantom mega-delinquency.
    expect(rows.some((r) => r.tenant === 'demoinf')).toBe(false); // property-code total row
    expect(rows.some((r) => /grand|total/i.test(r.tenant))).toBe(false);
    expect(rows).toHaveLength(3); // exactly the three real tenants
  });
});

describe('parseArAging — AppFolio Aged Receivable', () => {
  const { format, rows } = parseArAging(APPFOLIO);
  it('detects the format', () => expect(format).toBe('appfolio-aged-receivable'));

  it('reads the tenant from the unit header and buckets from the last 4 subtotal tokens', () => {
    const bravo = rows.find((r) => r.tenant === 'Bravo Tenant');
    expect(bravo).toMatchObject({ d30: 0, d60: 0, d90: 900, d90plus: 0 });
    expect(bravo!.property).toContain('102 Demo Drive');
  });

  it('maps a 0-30 balance to d30', () => {
    expect(rows.find((r) => r.tenant === 'Acme Service Co')).toMatchObject({ d30: 15, d60: 0, d90: 0, d90plus: 0 });
  });

  it('clamps a negative 91+/61-90 credit to 0', () => {
    expect(rows.find((r) => r.tenant === 'Echo Credit LLC')).toMatchObject({ d30: 0, d60: 0, d90: 0, d90plus: 0 });
  });

  it('excludes the grand Total row', () => {
    expect(rows).toHaveLength(3);
    expect(rows.some((r) => /total/i.test(r.tenant))).toBe(false);
  });
});

describe('isGarbageExtraction — image-PDF detection', () => {
  it('returns false for normal ASCII text', () => {
    expect(isGarbageExtraction('Aging Detail Page 1\nTenant Name Current 0-30 31-60\nAcme Co 0.00 100.00 0.00')).toBe(false);
  });
  it('returns true when >30% of first 800 chars are non-ASCII (CID garbage)', () => {
    // Real CID output from pdfplumber uses chars >127 (e.g. \x80–\xff, Unicode private-use).
    // Control chars \x00-\x1f are ASCII (≤127) and do NOT trigger the guard.
    const cid = '\x80\x90\xa0\xb0\xc0\xd0\xe0\xf0'.repeat(40) + 'abc'.repeat(10);
    expect(isGarbageExtraction(cid)).toBe(true);
  });
  it('returns true when extracted text is nearly empty (image-only page)', () => {
    expect(isGarbageExtraction('   \n  ')).toBe(true);
  });
});

describe('parseArAging — Yardi name-filter edge cases (tenants named "Total…" or "Grand…")', () => {
  // Yardi column order: Current  0-30  31-60  61-90  Over90  Prepay  Total
  //                     [0]      [1]   [2]    [3]    [4]     [5]     [6]
  // d30=tokens[1]  d60=tokens[2]  d90=tokens[3]  d90plus=tokens[4]
  const YARDI_TOTAL_GRAND = `Aging Detail Page 1
demoinf (demoinf)
Total Wine & More (t0000099)
demoinf Total Wine & More Current C-99 GPRENT 05/01/2024 05/2024 0.00 0.00 0.00 0.00 9000.00 0.00 9000.00
Total Wine & More 0.00 0.00 0.00 0.00 9000.00 0.00 9000.00
Grand Rapids Storage (t0000100)
demoinf Grand Rapids Storage Current C-100 GPRENT 05/01/2024 05/2024 0.00 0.00 0.00 7000.00 0.00 0.00 7000.00
Grand Rapids Storage 0.00 0.00 0.00 7000.00 0.00 0.00 7000.00
demoinf 0.00 0.00 0.00 7000.00 9000.00 0.00 16000.00
Grand Total 0.00 0.00 0.00 7000.00 9000.00 0.00 16000.00`;

  it('emits "Total Wine & More" (starts with "Total") with d90plus=9000', () => {
    const { rows } = parseArAging(YARDI_TOTAL_GRAND);
    const row = rows.find((r) => r.tenant === 'Total Wine & More');
    expect(row).toBeDefined();
    expect(row).toMatchObject({ d30: 0, d60: 0, d90: 0, d90plus: 9000 });
  });

  it('emits "Grand Rapids Storage" (starts with "Grand") with d90=7000', () => {
    const { rows } = parseArAging(YARDI_TOTAL_GRAND);
    const row = rows.find((r) => r.tenant === 'Grand Rapids Storage');
    expect(row).toBeDefined();
    expect(row).toMatchObject({ d30: 0, d60: 0, d90: 7000, d90plus: 0 });
  });

  it('still suppresses the literal "Grand Total" summary row', () => {
    const { rows } = parseArAging(YARDI_TOTAL_GRAND);
    expect(rows.some((r) => /^grand total$/i.test(r.tenant))).toBe(false);
    expect(rows).toHaveLength(2);
  });

  it('suppresses a property-display-name total (display label used in subtotal row instead of code)', () => {
    const TEXT = `Aging Detail Page 1
29000 Information Lane (29000inf)
Acme Co (t0000001)
29000inf Acme Co Current C-1 GPRENT 05/01/2024 05/2024 100.00 100.00 0.00 0.00 0.00 0.00 100.00
Acme Co 100.00 100.00 0.00 0.00 0.00 0.00 100.00
29000 Information Lane 500.00 9000.00 0.00 0.00 0.00 0.00 9500.00`;
    const { rows } = parseArAging(TEXT);
    expect(rows.some((r) => r.tenant === '29000 Information Lane')).toBe(false);
    expect(rows).toHaveLength(1);
  });
});

describe('parseArAging — AppFolio edge case (tenant name starts with "Total")', () => {
  const TOTAL_TENANT = `Aged Receivable Detail
Payer Name GL Account Name Total Amount 0-30 31-60 61-90 91+
demo - 100 Main St - Unit A - Total Comfort HVAC
Total Comfort HVAC 08/01/2024 08/01/2024 38100000 Rent 5000.00 5000.00 0.00 0.00 5000.00 0.00
5000.00 5000.00 0.00 0.00 5000.00 0.00
Total 5000.00 5000.00 0.00 0.00 5000.00 0.00`;

  it('emits "Total Comfort HVAC" with d90=5000 (detail lines must not be killed by /^total/)', () => {
    const { rows } = parseArAging(TOTAL_TENANT);
    const row = rows.find((r) => r.tenant === 'Total Comfort HVAC');
    expect(row).toBeDefined();
    expect(row).toMatchObject({ d30: 0, d60: 0, d90: 5000, d90plus: 0 });
  });

  it('does not emit an extra row for the grand Total footer', () => {
    const { rows } = parseArAging(TOTAL_TENANT);
    expect(rows).toHaveLength(1);
  });
});

describe('parseArAging — AppFolio multi-charge block (last money-only line is the true subtotal)', () => {
  // pdfplumber can wrap a GL detail row so its amounts extract onto their own money-only line.
  // The true subtotal is always LAST; taking the first gives wrong/understated arrears.
  const MULTI_CHARGE = `Aged Receivable Detail
Payer Name GL Account Name Total Amount 0-30 31-60 61-90 91+
demo - 1 Main St - Unit A - Northstar Logistics
6000.00 6000.00 6000.00 0.00 0.00 0.00
Northstar Logistics 08/01/2024 38200000 CAM 1000.00 1000.00 1000.00 0.00 0.00 0.00
7000.00 7000.00 7000.00 0.00 0.00 0.00
Total 7000.00 7000.00 7000.00 0.00 0.00 0.00`;

  it('reports d30=7000 (true subtotal), not d30=6000 (orphaned intermediate line)', () => {
    const { rows } = parseArAging(MULTI_CHARGE);
    const row = rows.find((r) => r.tenant === 'Northstar Logistics');
    expect(row).toBeDefined();
    expect(row).toMatchObject({ d30: 7000, d60: 0, d90: 0, d90plus: 0 });
  });

  it('emits exactly one row (no duplicate from the intermediate line)', () => {
    const { rows } = parseArAging(MULTI_CHARGE);
    expect(rows).toHaveLength(1);
  });
});

describe('parseArAging — unsupported / unknown', () => {
  it('rejects the bucket-less Delinquency report with a reason, never a silent empty', () => {
    const res = parseArAging(DELINQUENCY);
    expect(res.format).toBe('rent-manager-delinquency');
    expect(res.rows).toEqual([]);
    expect(res.unsupportedReason).toMatch(/no aging buckets/i);
  });

  it('flags an unrecognized format', () => {
    const res = parseArAging('nothing useful here');
    expect(res.format).toBe('unknown');
    expect(res.unsupportedReason).toBeTruthy();
  });
});
