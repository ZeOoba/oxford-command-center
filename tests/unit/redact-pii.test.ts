import { describe, it, expect } from 'vitest';
import { redactNotesTextMainBaseline } from './fixtures/redact-pii-main-baseline';
import { mapGraphTask } from '../../server/sources/m365-tasks';
import { htmlToText } from '../../server/sources/html-to-text';
import {
  redactNotesText,
  redactSnapshotNotes,
  EMAIL_PLACEHOLDER,
  PHONE_PLACEHOLDER,
  SIGNATURE_PLACEHOLDER,
  CONTACT_PLACEHOLDER,
} from '../../src/lib/redact-pii';

// All fixtures are synthetic: reserved example domains and the 555-01xx fictional phone block.
describe('redactNotesText', () => {
  it('redacts email addresses and keeps surrounding wording', () => {
    const out = redactNotesText('Send the COI to jane.roe+hvac@example.com before Friday.');
    expect(out).toBe(`Send the COI to ${EMAIL_PLACEHOLDER} before Friday.`);
  });

  it('redacts phone formats: (nnn) nnn-nnnn, dashes, dots, +1, extensions', () => {
    for (const p of ['(555) 010-0123', '555-010-0123', '555.010.0123', '+1 555 010 0123', '555-010-0123 x45', '555-010-0123 ext. 7']) {
      expect(redactNotesText(`reach me on ${p} today`)).toBe(`reach me on ${PHONE_PLACEHOLDER} today`);
    }
  });

  it('does not touch dates, amounts, parcel-style ids or bare long numbers', () => {
    const s = 'Closed 2026-08-28 for $1,575,000 on 19,910 SF, parcel 123-456-7890-12, ref 5550100123.';
    expect(redactNotesText(s)).toBe(s);
  });

  it('cuts a signature block at a Regards sign-off', () => {
    const out = redactNotesText('Can you confirm the date? Thanks.\nRegards,\nTest Person (555) 010-0123 (mobile) www.example.test 1 Main St, Testville');
    expect(out).toBe(`Can you confirm the date? Thanks. ${SIGNATURE_PLACEHOLDER}`);
  });

  it('treats a weak sign-off (Thanks,) as a signature only when contact data follows', () => {
    expect(redactNotesText('Thanks, I will follow up with the tenant on Monday.')).toBe(
      'Thanks, I will follow up with the tenant on Monday.',
    );
    expect(redactNotesText('Done.\nThanks, Test Person 555-010-0123')).toBe(`Done. ${SIGNATURE_PLACEHOLDER}`);
  });

  it('cuts at a "-- " delimiter line and "Sent from my" footers', () => {
    expect(redactNotesText('See attached.\n--\nTest Person\nExample Co')).toBe(`See attached. ${SIGNATURE_PLACEHOLDER}`);
    expect(redactNotesText('Will do.\nSent from my phone')).toBe(`Will do. ${SIGNATURE_PLACEHOLDER}`);
  });

  it('does not cut a very long tail after a sign-off cue', () => {
    const long = `Regards, ${'x '.repeat(200)}`;
    expect(redactNotesText(long)).toBe(long);
  });

  it('redacts mail-header names and Name <addr> pairs', () => {
    const out = redactNotesText('From: Test Person <tp@example.com> Sent: Monday To: Other Person <op@example.org>');
    expect(out).toBe(`From: ${CONTACT_PLACEHOLDER} Sent: Monday To: ${CONTACT_PLACEHOLDER}`);
    expect(redactNotesText('On Mon, Jan 20, 2026 at 9:40 AM Test Person < tp@example.com > wrote: ok')).toContain(CONTACT_PLACEHOLDER);
  });

  it('redacts a name directly before a phone number and a truncated "Name < addr" pair', () => {
    expect(redactNotesText('Need quote. Test Person (555) 010-0123 www.example.test')).toBe(
      `Need quote. ${CONTACT_PLACEHOLDER} ${PHONE_PLACEHOLDER} www.example.test`,
    );
    expect(redactNotesText('Plumber - 555-010-0123, Roofer - 555-010-0124')).not.toMatch(/555/);
    expect(redactNotesText('at 9:40 AM Test Person < tp@example.com')).toBe(`at 9:40 ${CONTACT_PLACEHOLDER}`);
  });

  it('drops an address fragment cut off by truncation', () => {
    expect(redactNotesText('To: Someone Else <someone.el')).not.toMatch(/someone\.el/);
  });

  it('redacts an email with no TLD (truncated domain)', () => {
    expect(redactNotesText('reach me at bob@examp')).toBe(`reach me at ${EMAIL_PLACEHOLDER}`);
  });

  it('is deterministic and idempotent', () => {
    const s = 'From: A B <ab@example.com> ok\nRegards, Test Person 555-010-0123 tp@example.com';
    const once = redactNotesText(s);
    expect(redactNotesText(s)).toBe(once);
    expect(redactNotesText(once)).toBe(once);
  });

  it('leaves clean text and the empty string unchanged', () => {
    expect(redactNotesText('')).toBe('');
    expect(redactNotesText('Renew COI; roof quote due 10/15.')).toBe('Renew COI; roof quote due 10/15.');
  });
});

describe('redactNotesText — review follow-up (2026-10-30)', () => {
  const idem = (s: string) => {
    const once = redactNotesText(s);
    expect(redactNotesText(once)).toBe(once);
    return once;
  };

  it('is idempotent on stacked truncated-address fragments', () => {
    expect(idem('note a <b <c')).toBe('note a');
  });

  it('is idempotent when email redaction shortens a tail under SIGNATURE_MAX_TAIL', () => {
    const email = `${'a'.repeat(50)}@example.test`.padEnd(66, 'x'); // 66 chars
    expect(email).toHaveLength(66);
    idem(`Regards, ${'x'.repeat(250)} ${email}`);
  });

  it('a mid-line sign-off word is business text, not a signature', () => {
    const s = 'Re roof. Regards, the $8,200 HVAC quote for Suite 104 covers the RTU swap; tenant pays $9.75/SF NNN.';
    expect(redactNotesText(s)).toBe(s);
  });

  it('a line-start sign-off is a signature only within the last ~5 lines', () => {
    const early = ['Regards,', 'line 1', 'line 2', 'line 3', 'line 4', 'line 5', 'line 6'].join('\n');
    expect(redactNotesText(early)).toBe(early);
    const late = ['Update below.', 'Roof done.', 'Regards,', 'Test Person', 'Example Co'].join('\n');
    expect(redactNotesText(late)).toBe(`Update below.\nRoof done. ${SIGNATURE_PLACEHOLDER}`);
  });

  it('still redacts contact data that follows a mid-line sign-off', () => {
    const out = redactNotesText('Done. Regards, Test Person 555-010-0123 tp@example.com');
    expect(out).not.toMatch(/555-010-0123|tp@example\.com|Test Person/);
  });

  it('keeps one-word companies and property names before a phone number (LLC/Inc/Company, Suite/Building/Park)', () => {
    for (const name of ['Acme LLC', 'Example Inc.', 'Sample Company', 'Building C', 'Suite B', 'Oakview Business Park']) {
      const out = redactNotesText(`Call ${name} 555-010-0123 re gutters`);
      expect(out).toBe(`Call ${name} ${PHONE_PLACEHOLDER} re gutters`);
    }
    // Round 3: two or more words in front of a legal suffix can be a person ("Call Jane Doe Acme
    // Inc"), even after a cue word, so a multi-word vendor is over-redacted -- the safe direction.
    for (const name of ['Acme Roofing LLC', 'Example Mechanical Inc.', 'Sample Paving Company']) {
      expect(redactNotesText(`Call ${name} 555-010-0123 re gutters`)).toBe(`${CONTACT_PLACEHOLDER} ${PHONE_PLACEHOLDER} re gutters`);
    }
    // Round 2: bare "Co" / "PC" are no longer suffixes ("Jane Doe Co" is a person), so a "... Co"
    // vendor is over-redacted -- the safe direction.
    expect(redactNotesText('Call Sample Paving Co 555-010-0123 re gutters')).toBe(`${CONTACT_PLACEHOLDER} ${PHONE_PLACEHOLDER} re gutters`);
  });

  it('keeps a one-word company display name in a mail header but redacts the address', () => {
    const out = redactNotesText('From: Acme LLC <billing@example.com> Sent: Monday');
    expect(out).toContain('Acme LLC');
    expect(out).not.toContain('billing@example.com');
    // Round 3: a two-word company name is over-redacted (it could be "Jane Doe Acme Inc").
    expect(redactNotesText('From: Acme Roofing LLC <billing@example.com> Sent: Monday')).toBe(`From: ${CONTACT_PLACEHOLDER} Sent: Monday`);
    expect(redactNotesText('To: Test Person <tp@example.com>')).toBe(`To: ${CONTACT_PLACEHOLDER}`);
  });
});

// Adversarial review 2026-10-30 (C2-C4). The snapshot guard runs the same function over the committed
// notes, so it can never catch a rule that is wrong; this FIXED synthetic corpus pins the cases.
// Synthetic only: reserved example domains, the 555-01xx fictional phone block, invented names.
describe('redactNotesText — regression corpus (adversarial review 2026-10-30)', () => {
  const CASES: Array<{ name: string; input: string; absent: string[]; present?: string[]; exact?: string }> = [
    // C3: single-line text (what htmlToText produces) with a strong mid-line sign-off.
    {
      name: 'C3 mid-line Regards with a short contact-only tail is cut',
      input: 'Approved the quote. Regards, Jane Doe Property Manager Acme Realty 1 Main St Testville',
      absent: ['Jane', 'Doe', 'Testville'],
      exact: `Approved the quote. ${SIGNATURE_PLACEHOLDER}`,
    },
    {
      name: 'C3 mid-line Best regards is cut',
      input: 'Will send Monday. Best regards, Jane Doe Acme Realty',
      absent: ['Jane'],
      exact: `Will send Monday. ${SIGNATURE_PLACEHOLDER}`,
    },
    { name: 'C3 mid-line Sincerely is cut', input: 'Lease signed. Sincerely, Jane Doe', absent: ['Jane'], exact: `Lease signed. ${SIGNATURE_PLACEHOLDER}` },
    { name: 'C3 mid-line Sent from my is cut', input: 'Ok will do. Sent from my iPhone', absent: ['iPhone'], exact: `Ok will do. ${SIGNATURE_PLACEHOLDER}` },
    {
      name: 'C3 mid-line Regards followed by business text is kept',
      input: 'Re roof. Regards, the $8,200 HVAC quote for Suite 104 covers the RTU swap; tenant pays $9.75/SF NNN.',
      absent: [],
      exact: 'Re roof. Regards, the $8,200 HVAC quote for Suite 104 covers the RTU swap; tenant pays $9.75/SF NNN.',
    },
    { name: 'C3 tail with SF is kept', input: 'Noted. Regards, renewal covers 12,000 SF', absent: [], exact: 'Noted. Regards, renewal covers 12,000 SF' },
    { name: 'C3 tail with a date is kept', input: 'Noted. Regards, inspection moved to 11/14', absent: [], exact: 'Noted. Regards, inspection moved to 11/14' },
    { name: 'C3 tail with a unit number is kept', input: 'Noted. Regards, Unit 7 keys at the desk', absent: [], exact: 'Noted. Regards, Unit 7 keys at the desk' },
    { name: 'C3 "with regards to" is not a sign-off', input: 'Tenant called with regards to the roof leak', absent: [], exact: 'Tenant called with regards to the roof leak' },
    // C4: a business token next to a person must not keep the person's name.
    { name: 'C4 Mike Park before a phone', input: 'Call Mike Park 555-010-0123', absent: ['Mike', '555-010-0123'] },
    { name: 'C4 Jane Group before a phone', input: 'Call Jane Group 555-010-0123', absent: ['Jane', '555-010-0123'] },
    {
      name: 'C4 header with person, company',
      input: 'From: Jane Doe, Acme Realty <jdoe@example.com> Sent: Monday',
      absent: ['Jane', 'Doe', 'jdoe@example.com'],
      present: ['Sent: Monday'],
    },
    {
      name: 'C4 company then person before an address',
      input: 'cc Acme LLC Jane Doe <jdoe@example.com> re roof',
      absent: ['Jane', 'Doe', 'jdoe@example.com'],
      present: ['Acme LLC', 're roof'],
    },
    { name: 'C4 suite then person before a phone', input: 'Suite B Jane 555-010-0123 re keys', absent: ['Jane', '555-010-0123'], present: ['Suite B', 're keys'] },
    // Kept business names (the vendor / the property is the business fact).
    { name: 'keeps a one-word LLC vendor', input: 'Call Acme LLC 555-010-0123 re gutters', absent: ['555-010-0123'], present: ['Acme LLC'] },
    // Round 3: a two-word vendor is over-redacted (the person-first shape cannot be told apart).
    { name: 'R3 a two-word LLC vendor is over-redacted', input: 'Call Acme Roofing LLC 555-010-0123 re gutters', absent: ['555-010-0123', 'Roofing'], present: ['re gutters'] },
    { name: 'keeps a business park', input: 'Call Oakview Business Park 555-010-0123 re gutters', absent: ['555-010-0123'], present: ['Oakview Business Park'] },

    // Round 2 (2026-10-30). C4 regression: the {0,4} / {0,2} words in front of a legal suffix or a
    // place descriptor swallowed a person's name, keeping it as part of the "company".
    { name: 'R2-C4 person before an Inc company', input: 'Jane Doe Acme Inc 614-555-0123 re roof', absent: ['Jane', 'Doe', '614-555-0123'], present: ['re roof'] },
    { name: 'R2-C4 bare Co is not a suffix', input: 'Jane Doe Co 614-555-0123 re roof', absent: ['Jane', 'Doe', '614-555-0123'], present: ['re roof'] },
    { name: 'R2-C4 bare PC is not a suffix', input: 'Jane Doe PC 614-555-0123 re roof', absent: ['Jane', 'Doe', '614-555-0123'], present: ['re roof'] },
    { name: 'R2-C4 person-named Park before a Business Park', input: 'Mike Park Business Park 614-555-0123 re gutters', absent: ['Mike', '614-555-0123'], present: ['re gutters'] },
    { name: 'R2-C4 cue + person-named Park before a Business Park', input: 'Call Mike Park Business Park 614-555-0123 re gutters', absent: ['Mike', '614-555-0123'], present: ['re gutters'] },
    { name: 'R2-C4 person before an Industrial Park (phone)', input: 'Jane Doe Industrial Park 614-555-0123 re gutters', absent: ['Jane', 'Doe', '614-555-0123'], present: ['re gutters'] },
    { name: 'R2-C4 person before an Industrial Park (address)', input: 'Jane Doe Industrial Park <jdoe@example.com> re gutters', absent: ['Jane', 'Doe', 'jdoe@example.com'], present: ['re gutters'] },
    { name: 'R2-C4 person, company Inc in a header', input: 'From: Jane Doe, Acme Realty Inc <jdoe@example.com> re lease', absent: ['Jane', 'Doe', 'jdoe@example.com'], present: ['re lease'] },
    // Round 3: was kept after a cue word (up to 4 words); now capped at 1 word, so over-redacted.
    { name: 'R3 a cue-led multi-word LLC vendor is over-redacted', input: 'Attn Acme Roofing Supply LLC 614-555-0123 re gutters', absent: ['614-555-0123', 'Roofing'], present: ['re gutters'] },
    // NAME_PHONE_RE looked only 3 words back, splitting a place + building id.
    {
      name: 'R2 business park + building id is not split',
      input: 'Oakview Business Park Building C 614-555-0123 re gutters',
      absent: ['614-555-0123', CONTACT_PLACEHOLDER],
      present: ['Oakview Business Park Building C', 're gutters'],
    },
    // M365 header shape (the html-to-text tag strip is covered in m365-tasks.test.ts).
    { name: 'R2 header person, company before an address', input: 'From: Jane Doe, Acme Realty <jdoe@example.com> re lease', absent: ['Jane', 'Doe', 'jdoe@example.com'], present: ['re lease'] },
    // Weak sign-off mid-line (single-line M365 text) with a contact tail is cut.
    {
      name: 'R2 mid-line Thanks with a contact tail is cut',
      input: 'Please review the bid. Thanks, Robert Jones Senior Project Manager Allied Mechanical 614-555-0123 rjones@example.com',
      absent: ['Robert', 'Jones', 'Allied', 'rjones'],
      exact: `Please review the bid. ${SIGNATURE_PLACEHOLDER}`,
    },
    {
      name: 'R2 mid-line Thanks with no contact data is kept',
      input: 'Please review the bid. Thanks, Robert will walk the roof Friday',
      absent: [SIGNATURE_PLACEHOLDER],
      exact: 'Please review the bid. Thanks, Robert will walk the roof Friday',
    },
    // C3 over-cut: a cue followed by lower-case prose, or by a capitalised word that opens a sentence.
    {
      name: 'R2-C3 "with regards," is prose',
      input: 'Following up with regards, the roof at Riverside Commons',
      absent: [SIGNATURE_PLACEHOLDER],
      exact: 'Following up with regards, the roof at Riverside Commons',
    },
    {
      name: 'R2-C3 Regards, + lower-case continuation is prose',
      input: 'Lease expires 12/31/2026. Regards, the tenant will renew for five years',
      absent: [SIGNATURE_PLACEHOLDER],
      exact: 'Lease expires 12/31/2026. Regards, the tenant will renew for five years',
    },
    {
      name: 'R2-C3 Sincerely, + a sentence (line start) is prose',
      input: "Sincerely, Lowe's will deliver Friday morning",
      absent: [SIGNATURE_PLACEHOLDER],
      exact: "Sincerely, Lowe's will deliver Friday morning",
    },
    {
      name: 'R2-C3 Sincerely, + a sentence (mid-line) is prose',
      input: "Order placed. Sincerely, Lowe's will deliver Friday morning",
      absent: [SIGNATURE_PLACEHOLDER],
      exact: "Order placed. Sincerely, Lowe's will deliver Friday morning",
    },
    {
      name: 'R2-C3 a name-only Regards tail is still cut',
      input: 'Approved. Regards, Jane Doe Director of Leasing',
      absent: ['Jane'],
      exact: `Approved. ${SIGNATURE_PLACEHOLDER}`,
    },

    // Round 3 (2026-10-30): each shape must leak no more than main.
    // 1. The "with regards" guard is gone; the capital-letter check alone keeps the prose case above.
    { name: 'R3 "with regards, Jane" is cut', input: 'with regards, Jane', absent: ['Jane'], exact: `with ${SIGNATURE_PLACEHOLDER}` },
    { name: 'R3 "with regards, Jane Doe" mid-line is cut', input: 'Following up with regards, Jane Doe', absent: ['Jane', 'Doe'] },
    // 2. A mid-line cue in multi-line text: cut as main does.
    {
      name: 'R3 mid-line Regards then a multi-line name block is cut',
      input: 'Please confirm the COI. Regards,\nJane Doe\nAcme Roofing LLC',
      absent: ['Jane', 'Doe', 'Acme'],
      exact: `Please confirm the COI. ${SIGNATURE_PLACEHOLDER}`,
    },
    {
      name: 'R3 mid-line Regards + name on its line, address lines below, is cut',
      input: 'COI received. Regards, Jane Doe\nAcme Realty\n1 Main St Suite 200',
      absent: ['Jane', 'Doe', 'Acme'],
      exact: `COI received. ${SIGNATURE_PLACEHOLDER}`,
    },
    {
      name: 'R3 mid-line Thanks + multi-line contact tail is cut',
      input: 'Bid attached. Thanks,\nRobert Jones\n614-555-0142',
      absent: ['Robert', '555-0142'],
      exact: `Bid attached. ${SIGNATURE_PLACEHOLDER}`,
    },
    // Multi-line business text is not over-redacted.
    {
      name: 'R3 multi-line business note with no cue is kept',
      input: 'Roof quote $8,200 approved.\nSuite 104 renewal at $9.75/SF NNN.\nInspection 11/14.',
      absent: [SIGNATURE_PLACEHOLDER],
      exact: 'Roof quote $8,200 approved.\nSuite 104 renewal at $9.75/SF NNN.\nInspection 11/14.',
    },
    {
      name: 'R3 multi-line mid-line Regards + lower-case prose is kept',
      input: 'Re roof. Regards, the $8,200 quote is for Suite 104.\nTenant pays $9.75/SF from 11/14.\nKeys at the desk.',
      absent: [SIGNATURE_PLACEHOLDER],
      exact: 'Re roof. Regards, the $8,200 quote is for Suite 104.\nTenant pays $9.75/SF from 11/14.\nKeys at the desk.',
    },
    {
      name: 'R3 multi-line mid-line Regards + capitalised business facts is kept',
      input: 'Update. Regards, Suite 104 rent $9.75/SF from 11/14\nKeys at the desk',
      absent: [SIGNATURE_PLACEHOLDER],
      exact: 'Update. Regards, Suite 104 rent $9.75/SF from 11/14\nKeys at the desk',
    },
    {
      name: 'R3 multi-line line-start Thanks + business prose is kept',
      input: 'Thanks, the roof is done.\nSuite 104 owes $1,200 by 12/01.\nUnit 7 keys at the desk.',
      absent: [SIGNATURE_PLACEHOLDER],
      exact: 'Thanks, the roof is done.\nSuite 104 owes $1,200 by 12/01.\nUnit 7 keys at the desk.',
    },
    {
      name: 'R3 multi-line business lines then a signature: only the signature goes',
      input: 'Suite 104 owes $1,200 by 12/01.\nRoof quote $8,200.\nRegards,\nJane Doe\n614-555-0142',
      absent: ['Jane', '555-0142'],
      exact: `Suite 104 owes $1,200 by 12/01.\nRoof quote $8,200. ${SIGNATURE_PLACEHOLDER}`,
    },
    // 3. At most one name word in front of a company, even after a cue word.
    { name: 'R3 header person + company Inc', input: 'From: Jane Doe Acme Inc <jd@example.com> re roof', absent: ['Jane', 'Doe', 'jd@example.com'], present: ['re roof'] },
    { name: 'R3 header initials + company Inc', input: 'Cc: F L Acme Inc <x@example.com> re roof', absent: ['F L', 'x@example.com'], present: ['re roof'] },
    { name: 'R3 cue + person + company Inc + phone', input: 'Call Jane Doe Acme Inc 614-555-0142 re roof', absent: ['Jane', 'Doe', '555-0142'], present: ['re roof'] },
    { name: 'R3 cue + person + two-word LLC + phone', input: 'Call Jane Doe Acme Roofing LLC 614-555-0142 re roof', absent: ['Jane', 'Doe', '555-0142'], present: ['re roof'] },
    { name: 'R3 cue + person + two-word LLC + address', input: 'Call Jane Doe Acme Roofing LLC <jd@example.com> re roof', absent: ['Jane', 'Doe', 'jd@example.com'], present: ['re roof'] },
    // 4. An adjacent-phone run folds in one pass (the lookbehind skipped every second number, so x9
    //    outran the 8-pass cap and the last one stayed raw).
    { name: 'R3 nine adjacent phones', input: '(614) 555-0142'.repeat(9), absent: ['555-0142', '(614)'] },
    { name: 'R3 forty adjacent phones', input: `call ${'(614) 555-0142'.repeat(40)} re roof`, absent: ['555-0142', '(614)'], present: ['re roof'] },
  ];

  for (const c of CASES) {
    it(c.name, () => {
      const out = redactNotesText(c.input);
      for (const a of c.absent) expect(out).not.toContain(a);
      for (const p of c.present ?? []) expect(out).toContain(p);
      if (c.exact !== undefined) expect(out).toBe(c.exact);
      expect(redactNotesText(out)).toBe(out);
    });
  }

  // C2: one removal per pass meant 9-10+ stacked fragments (or sign-off blocks) outran the
  // fixed-point cap, so f(f(x)) !== f(x).
  it('is idempotent over a corpus incl. 20 address fragments and 10 stacked Regards blocks', () => {
    const corpus = [
      ...CASES.map((c) => c.input),
      `note a${' <frag'.repeat(20)}`,
      `note a${' <b'.repeat(9)}`,
      `note a${' <b'.repeat(10)}`,
      `Status ok.${' Regards, Jane Doe'.repeat(10)}`,
      `Status ok.${'\nRegards,\nJane Doe'.repeat(10)}`,
      `Status ok.${'\nRegards,\nJane Doe 555-010-0123 jdoe@example.com'.repeat(10)}`,
      `Status ok.${' Regards, Jane Doe jdoe@example.com <jd'.repeat(10)}`,
      `Status ok. Regards, ${'x'.repeat(130)} Regards, Jane Doe`,
    ];
    for (const s of corpus) {
      const once = redactNotesText(s);
      expect(redactNotesText(once)).toBe(once);
    }
    expect(redactNotesText(`note a${' <frag'.repeat(20)}`)).toBe('note a');
    expect(redactNotesText(`Status ok.${' Regards, Jane Doe'.repeat(10)}`)).toBe(`Status ok. ${SIGNATURE_PLACEHOLDER}`);
    expect(redactNotesText(`Status ok.${'\nRegards,\nJane Doe'.repeat(10)}`)).toBe(`Status ok. ${SIGNATURE_PLACEHOLDER}`);
  });
});

// Round 3: "strictly no worse than main" as a property. A small corpus is generated from the review's
// shapes (sign-off cues, header / cue + person + company spans, adjacent phones); for every input the
// count of planted PII tokens left in the PR output must be <= the count main (a frozen copy in
// fixtures/) leaves. Synthetic only: invented names, example domains, the 555-01xx block.
describe('redactNotesText — leaks no more than main (round 3)', () => {
  const FIRST = ['Jane', 'Robert', 'Maria', 'F'];
  const LAST = ['Doe', 'Jones', 'Lopez', 'L'];
  const COMPANY = ['Acme Inc', 'Acme Roofing LLC', 'Allied Mechanical Corp', 'Oakview Business Park'];
  const PHONE = '614-555-0142';
  const EMAIL = 'jd@example.com';
  type Gen = { input: string; pii: string[] };
  const corpus: Gen[] = [];
  for (const f of FIRST) {
    for (const l of LAST) {
      const pii = [f, l];
      corpus.push({ input: `with regards, ${f}`, pii: [f] });
      corpus.push({ input: `Following up with regards, ${f} ${l}`, pii });
      corpus.push({ input: `Please confirm the COI. Regards,\n${f} ${l}\nAcme Roofing LLC`, pii });
      corpus.push({ input: `Bid attached. Thanks,\n${f} ${l}\n${PHONE}`, pii: [...pii, PHONE] });
      for (const c of COMPANY) {
        for (const cue of ['From:', 'Cc:', 'To:', 'Call', 'Attn', '']) {
          corpus.push({ input: `${cue} ${f} ${l} ${c} <${EMAIL}> re roof`.trim(), pii: [...pii, EMAIL] });
          corpus.push({ input: `${cue} ${f} ${l} ${c} ${PHONE} re roof`.trim(), pii: [...pii, PHONE] });
        }
      }
    }
  }
  for (const n of [1, 2, 8, 9, 10, 20]) corpus.push({ input: `call ${'(614) 555-0142'.repeat(n)} re roof`, pii: ['555-0142'] });

  const leaks = (out: string, pii: string[]): number =>
    pii.reduce((k, t) => k + (new RegExp(`(?<![\\w])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w])`).test(out) ? 1 : 0), 0);

  it('PR output leaks <= main on every one of the generated inputs', () => {
    expect(corpus.length).toBeGreaterThan(300);
    const worse: string[] = [];
    let prTotal = 0;
    let mainTotal = 0;
    for (const g of corpus) {
      const pr = leaks(redactNotesText(g.input), g.pii);
      const main = leaks(redactNotesTextMainBaseline(g.input), g.pii);
      prTotal += pr;
      mainTotal += main;
      if (pr > main) worse.push(`${g.input} -> pr ${pr} > main ${main}`);
    }
    expect(worse).toEqual([]);
    expect(prTotal).toBeLessThanOrEqual(mainTotal);
  });
});

// Round 4 (2026-10-30): shapes the round-3 corpus missed, each of which leaked on 83aabeb0 where main
// cut it: 1- and 3-word names, a strong cue followed by Suite / date / $, quoted names, an emoji
// before the name, sign-off blocks taller than SIGNATURE_MAX_LINES, single-line tails over 120 chars.
// Every input also goes through mapGraphTask and is compared with main applied to the same 200-char
// slice of htmlToText -- the M365 path the snapshot actually takes.
describe('redactNotesText — leaks no more than main (round 4)', () => {
  const NAMES: [string, string[]][] = [
    ['Jane', ['Jane']],
    ['Jane Doe', ['Jane', 'Doe']],
    ['Robert Lee Okafor', ['Robert', 'Okafor']],
  ];
  const CUES = ['Regards,', 'Best regards,', 'Sincerely,', 'Kind Regards,'];
  const PHONE = '(614) 555-0187';
  const EMAIL = 'r.q@example.com';
  type Gen = { input: string; pii: string[] };
  const corpus: Gen[] = [];
  for (const [n, pii] of NAMES) {
    for (const cue of CUES) {
      for (const fact of ['Suite 200', '10/28', 'Nov 3', '$4,250', '12,500 SF']) {
        corpus.push({ input: `Roof ok. ${cue} ${n} ${fact}`, pii });
      }
      corpus.push({ input: `Roof ok. ${cue} "${n}"`, pii });
      corpus.push({ input: `Roof ok. ${cue} '${n}'`, pii });
      corpus.push({ input: `Roof ok. ${cue} \u{1F44D} ${n}`, pii });
      corpus.push({ input: `Approved. ${cue} ${n} Acme Realty 1 Main St Suite 200 Testville`, pii });
      const block = [n, 'VP Operations', 'Acme Realty', '1 Main St', 'Suite 200', 'Testville OH 43215'];
      corpus.push({ input: `Roof ok.\n${cue}\n${block.join('\n')}`, pii });
      corpus.push({ input: `Roof ok.\n${cue}\n${block.join('\n')}\n${PHONE}\n${EMAIL}`, pii: [...pii, '555-0187', EMAIL] });
      corpus.push({ input: `Roof ok. ${cue}\n${block.join('\n')}`, pii });
    }
    for (const cue of ['Thank you,', 'Thanks,', ...CUES]) {
      corpus.push({
        input: `COI received. ${cue} ${n}, Oakview Business Park, VP Operations, 1 Main St Suite 200 Testville OH 43215, C: ${PHONE}, ${EMAIL}`,
        pii: [...pii, '555-0187', EMAIL],
      });
    }
  }

  const leaks = (out: string, pii: string[]): number =>
    pii.reduce((k, t) => k + (new RegExp(`(?<![\\w])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w])`).test(out) ? 1 : 0), 0);
  const toHtml = (text: string): string =>
    `<html><body>${text.split('\n').map((l) => `<p>${l.replace(/&/g, '&amp;')}</p>`).join('')}</body></html>`;

  it('PR output leaks <= main on every one of the generated inputs', () => {
    expect(corpus.length).toBeGreaterThan(150);
    const worse: string[] = [];
    for (const g of corpus) {
      const pr = leaks(redactNotesText(g.input), g.pii);
      const main = leaks(redactNotesTextMainBaseline(g.input), g.pii);
      if (pr > main) worse.push(`${JSON.stringify(g.input)} -> pr ${pr} > main ${main}`);
    }
    expect(worse).toEqual([]);
  });

  it('mapGraphTask notes leak <= main applied to htmlToText(...).slice(0, 200), and stay bounded', () => {
    const worse: string[] = [];
    for (const g of corpus) {
      const html = toHtml(g.input);
      const note = mapGraphTask({ id: 'x', title: 't', body: { content: html } }, 'L')?.notes ?? '';
      const main = redactNotesTextMainBaseline(htmlToText(html).slice(0, 200));
      expect(note.length).toBeLessThanOrEqual(200);
      expect(redactNotesText(note)).toBe(note);
      if (leaks(note, g.pii) > leaks(main, g.pii)) worse.push(`${JSON.stringify(g.input)} -> ${JSON.stringify(note)}`);
    }
    expect(worse).toEqual([]);
  });

  it('keeps a place name that ends a sentence before a "Call <company> <phone>" line', () => {
    expect(redactNotesText('Roof leak at Riverside Commerce Center.\nCall Acme LLC 614-555-0100')).toBe(
      `Roof leak at Riverside Commerce Center.\nCall Acme LLC ${PHONE_PLACEHOLDER}`,
    );
  });

  it('still redacts a name on the line directly above its phone (as main does)', () => {
    for (const s of [
      'Roof ok.\nJane Doe\n614-555-0142',
      'Roof ok.\nJane Doe\n(614) 555-0142',
      'Status.\nJane Doe -\n614-555-0142',
      'Status.\nJane Doe Jr.\n614-555-0142',
      'Status.\nRobert A.\n614-555-0142',
    ]) {
      const out = redactNotesText(s);
      expect(out, s).not.toMatch(/\b(?:Jane|Doe|Robert)\b/);
      expect(leaks(out, ['Jane', 'Doe', 'Robert'])).toBeLessThanOrEqual(
        leaks(redactNotesTextMainBaseline(s), ['Jane', 'Doe', 'Robert']),
      );
    }
  });
});

describe('redactSnapshotNotes', () => {
  it('rewrites only string values under "notes" and counts changes', () => {
    const input = {
      id: 'a-1',
      amount: 1234.5,
      email: 'keep@example.com', // structured contact field: out of scope, must be untouched
      nextAction: 'call 555-010-0123',
      tasks: [
        { id: 't1', notes: 'ping x@example.com', done: false },
        { id: 't2', notes: null, n: 3 },
        { id: 't3', notes: 'clean note' },
      ],
    };
    const snapshot = JSON.parse(JSON.stringify(input));
    const { value, changed } = redactSnapshotNotes(input);
    expect(changed).toBe(1);
    expect(input).toEqual(snapshot); // input not mutated
    expect(value.tasks[0]?.notes).toBe(`ping ${EMAIL_PLACEHOLDER}`);
    expect(value.tasks[1]).toEqual({ id: 't2', notes: null, n: 3 });
    expect(value.email).toBe('keep@example.com');
    expect(value.nextAction).toBe('call 555-010-0123');
    expect(Object.keys(value)).toEqual(Object.keys(input));
  });
});
