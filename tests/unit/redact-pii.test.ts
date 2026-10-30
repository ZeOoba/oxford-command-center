import { describe, it, expect } from 'vitest';
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

  it('keeps company and property names before a phone number (LLC/Inc/Co, Suite/Building/Park)', () => {
    for (const name of ['Acme Roofing LLC', 'Example Mechanical Inc.', 'Sample Paving Co', 'Building C', 'Suite B', 'Oakview Business Park']) {
      const out = redactNotesText(`Call ${name} 555-010-0123 re gutters`);
      expect(out).toBe(`Call ${name} ${PHONE_PLACEHOLDER} re gutters`);
    }
  });

  it('keeps a company display name in a mail header but redacts the address', () => {
    const out = redactNotesText('From: Acme Roofing LLC <billing@example.com> Sent: Monday');
    expect(out).toContain('Acme Roofing LLC');
    expect(out).not.toContain('billing@example.com');
    expect(redactNotesText('To: Test Person <tp@example.com>')).toBe(`To: ${CONTACT_PLACEHOLDER}`);
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
