import { describe, it, expect } from 'vitest';
import { parseArAging, detectArFormat } from '../../server/ar/ar-aging';

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
