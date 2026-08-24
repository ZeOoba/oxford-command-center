import { describe, it, expect } from 'vitest';
import { resolvePropertyId } from '../../server/workbook/parse';
import type { Property } from '@contracts/index';

/** Minimal fixture builder — resolvePropertyId only reads id/address; every other Property field
 *  is required by the schema but irrelevant here, so fill it with inert defaults. */
function mkProperty(id: string, address: string): Property {
  return {
    id,
    index: null,
    name: address,
    address,
    city: null,
    state: null,
    market: 'Other',
    type: 'Flex',
    sf: 0,
    tenantCount: 0,
    occPct: 0,
    acqDate: null,
    estValue100: 0,
    oxfordOwnPct: 1,
    oxfordValue: 0,
    grossIncome: 0,
    expenses: 0,
    noi: 0,
    noiScenarioAdj: 0,
    debtService: 0,
    netCashFlow: 0,
    capRate: null,
    dscr: null,
    lender: null,
    loanBalance: 0,
    ltv: null,
    valuePerSf: null,
    rentPerSf: null,
    equityInvested: 0,
    cashOnCash: null,
    holdYrs: null,
    encumbered: false,
    flags: [],
  };
}

describe('resolvePropertyId', () => {
  it('matches the correct property by street name and number', () => {
    const properties = [
      mkProperty('1900-n-broadway-baltimore-md', '1900 N Broadway, Baltimore MD'),
      mkProperty('3034-westerville-rd-columbus-oh', '3034 Westerville Rd, Columbus OH'),
    ];
    expect(resolvePropertyId('3034 Westerville Road', properties)).toBe('3034-westerville-rd-columbus-oh');
  });

  // OI-184: '3034 Westerville ROAD' matched '1900 N Broadway, Baltimore MD' on the substring
  // 'road' ("b-ROAD-way"), purely because Baltimore's entry sat earlier in the properties array —
  // both of Westerville's real leases (Buckeye's Best Transport $13,005/mo, Lamar Advertising
  // billboard $300/mo) were mis-tagged to a property in a different state. Whole-token equality
  // means 'road' as a standalone key token never equals 'broadway' as a whole address token, so
  // Baltimore scores 0 here regardless of row order; Westerville scores 2 ('3034' + 'westerville')
  // and wins outright. Deliberately keeps Baltimore FIRST in the array — this is the exact order
  // that made the pre-fix substring algorithm return the wrong property.
  it('does not let a generic street-suffix word collide with an unrelated word that merely contains it', () => {
    const properties = [
      mkProperty('1900-n-broadway-baltimore-md', '1900 N Broadway, Baltimore MD'), // earlier in array
      mkProperty('3034-westerville-rd-columbus-oh', '3034 Westerville Rd, Columbus OH'),
    ];
    expect(resolvePropertyId('3034 Westerville Road', properties)).toBe('3034-westerville-rd-columbus-oh');
  });

  // Refute pass (2026-08-17, same-day follow-up to OI-184): the first fix denylisted street
  // SUFFIXES only. The real rent-roll key '1900 North Broadway' still collided with an unrelated
  // property via 'north' — a directional, not a suffix — because 'north' is a raw substring of
  // 'Northwood'. Whole-token equality kills this the same way: 'north' as a standalone key token
  // never equals 'northwood' as a whole address token. Run BOTH array orders to prove the result
  // no longer depends on which property's row happens to sit first — the pre-fix algorithm flipped
  // between these two orders; this one must not.
  it('does not let a directional word collide with an unrelated word that contains it, in either row order', () => {
    const broadway = mkProperty('1900-n-broadway-baltimore-md', '1900 N Broadway, Baltimore MD');
    const northwood = mkProperty('2203-2207-northwood-dr-salisbury-md', '2203-2207 Northwood Dr, Salisbury MD');
    expect(resolvePropertyId('1900 North Broadway', [broadway, northwood])).toBe('1900-n-broadway-baltimore-md');
    expect(resolvePropertyId('1900 North Broadway', [northwood, broadway])).toBe('1900-n-broadway-baltimore-md');
  });

  // Refute pass: a rent-roll key equal to the property's own canonical name — the most natural
  // copy-paste value — carries a city token ('columbus') shared by every Columbus OH property.
  // ANY-token substring matching let that shared token alone decide the winner by row order,
  // resolving Westerville's own full address to an unrelated Columbus property. Scoring by
  // matched-token COUNT means the property matching both distinctive tokens ('3034',
  // 'westerville') strictly outscores one matching only the shared city token, regardless of order.
  it('does not let a city token shared by multiple properties outweigh a distinctive street match', () => {
    const properties = [
      mkProperty('3540-e-5th-ave-columbus-oh', '3540 E. 5th Ave, Columbus OH'), // earlier in array
      mkProperty('3034-westerville-rd-columbus-oh', '3034 Westerville Rd, Columbus OH'),
    ];
    expect(resolvePropertyId('3034 Westerville Rd, Columbus OH', properties)).toBe('3034-westerville-rd-columbus-oh');
  });

  it('still matches on the distinctive street name alone when no suffix word is present', () => {
    const properties = [mkProperty('7658-fishel-dr-n-dublin-oh', '7658 Fishel Dr N, Dublin OH')];
    expect(resolvePropertyId('7658 Fishel Drive', properties)).toBe('7658-fishel-dr-n-dublin-oh');
  });

  it('still resolves a real address whose distinguishing word ("Route") is itself a generic street-type term', () => {
    const properties = [
      mkProperty('1900-n-broadway-baltimore-md', '1900 N Broadway, Baltimore MD'),
      mkProperty('9620-e-state-route-350-raytown-mo', '9620 E State Route 350, Raytown MO'),
    ];
    expect(resolvePropertyId('9620 E State Route 350', properties)).toBe('9620-e-state-route-350-raytown-mo');
  });

  it('returns null on a genuine tie rather than guessing', () => {
    // Round-5 refute finding: 'Plaza' alone is in GENERIC_WORDS, so both candidates below were
    // being rejected at the distinctiveMatch gate BEFORE reaching the tie logic at all -- the
    // asserted null came from the empty-eligible branch, not tied=true, leaving the tie->null
    // guard itself with zero test coverage. 'Persimmon Tree' is NOT generic, so both candidates
    // below score 2 and reach the tie comparator for real.
    const properties = [
      mkProperty('a', '1 Persimmon Tree Way, Anytown MD'),
      mkProperty('b', '2 Persimmon Tree Ct, Othertown MD'),
    ];
    expect(resolvePropertyId('Persimmon Tree', properties)).toBeNull();
  });

  it('returns null when nothing matches, rather than guessing', () => {
    const properties = [mkProperty('a', '55 New Plant Ct, Owings Mills MD')];
    expect(resolvePropertyId('Completely Unrelated Address', properties)).toBeNull();
  });

  // Found by the refute pass's own differential replay against the live snapshot while verifying
  // THIS fix: word-overlap scoring alone let a Sepich-portfolio sub-address ('4595 E. 5th Ave') that
  // has no standalone Property record match an unrelated real property ('3540 E. 5th Ave, Columbus
  // OH') purely on the shared street NAME + suffix ('5th', 'ave') — two different buildings on the
  // same street. A key carrying a street number must have that number appear in the winning
  // candidate's address too, or the match is rejected outright, not merely outscored.
  it('does not let a shared street name outweigh a mismatched street number', () => {
    const properties = [mkProperty('3540-e-5th-ave-columbus-oh', '3540 E. 5th Ave, Columbus OH')];
    expect(resolvePropertyId('4595 E. 5th Ave', properties)).toBeNull();
  });

  // Round-2 refute finding: an earlier version of the street-number guard required EXACT equality,
  // which silently nulled every lease on a real multi-suite range address ('2203-2207 Northwood Dr'
  // hosts leases individually keyed by suite numbers inside that range, not the two boundary
  // numbers themselves). A range check fixes the false negative without reopening the Sepich
  // false-positive above (4595 is nowhere near 3540's own single-number range).
  it('matches a suite number that falls within a real multi-number range address', () => {
    const properties = [mkProperty('2203-2207-northwood-dr-salisbury-md', '2203-2207 Northwood Dr, Salisbury MD')];
    expect(resolvePropertyId('2205 Northwood', properties)).toBe('2203-2207-northwood-dr-salisbury-md');
  });

  // Round-2 refute finding: a single shared GENERIC word, with no street-number corroboration,
  // is not enough signal — 'lane' alone would otherwise mis-tag a Sepich-portfolio name-only key
  // to an unrelated property in a different state purely because that word happens to be spelled
  // out in exactly one property's address.
  it('does not let one bare shared word decide the match with no corroborating signal', () => {
    const properties = [mkProperty('29000-information-lane-easton-md', '29000 Information Lane, Easton MD')];
    expect(resolvePropertyId('Banwick Lane', properties)).toBeNull();
  });

  // Round-2 refute finding: a coincidentally-matching street number with zero corroborating word
  // overlap is equally insufficient on its own — a hypothetical 'Banwick 401' key must not mis-tag
  // to a property whose only shared token is the bare number.
  it('does not let a coincidental bare number decide the match with no corroborating word', () => {
    const properties = [mkProperty('401-sunburst-hwy-cambridge-md', '401 Sunburst Hwy, Cambridge MD')];
    expect(resolvePropertyId('Banwick 401', properties)).toBeNull();
  });

  // Round-2 refute finding: disambiguatePropertyIds exists BECAUSE the human-maintained Properties
  // sheet sometimes carries a genuine duplicate row for the same physical property (suffixed '-2',
  // not merged). An earlier version of the tie rule nulled every lease on that property whenever a
  // duplicate row existed, since both rows always score identically. Two candidates sharing the
  // SAME normalized address are the same property, not ambiguity — the first should win.
  it('does not treat a duplicate row for the SAME address as ambiguous', () => {
    const properties = [
      mkProperty('1100-rarig-ave-columbus-oh', '1100 Rarig Ave, Columbus OH'),
      mkProperty('1100-rarig-ave-columbus-oh-2', '1100 Rarig Ave, Columbus OH'),
    ];
    expect(resolvePropertyId('1100 Rarig', properties)).toBe('1100-rarig-ave-columbus-oh');
  });

  // Round-3 refute finding: addressTokens' length>=3 filter was applied to KEY numbers too, so a
  // 1-2 digit house number never reached the numeric veto — the exact same-street-different-number
  // collision round 2 fixed for 4+ digit numbers reopened for short ones. '57' must disqualify the
  // real '55 New Plant Ct' the same way '4595' disqualifies '3540 E. 5th Ave' above.
  it('does not let a short (1-2 digit) mismatched street number bypass the numeric veto', () => {
    const properties = [mkProperty('55-new-plant-ct-owings-mills-md', '55 New Plant Ct, Owings Mills MD')];
    expect(resolvePropertyId('57 New Plant Court', properties)).toBeNull();
    expect(resolvePropertyId('55 New Plant Court', properties)).toBe('55-new-plant-ct-owings-mills-md');
  });

  // Round-3 refute finding: a bare numeric key resolved on the +1 number-range bonus alone, with
  // zero word evidence -- '2205' matched Northwood purely because 2205 falls inside its range,
  // never having shared a single word with it. The bonus may corroborate a word match; it must
  // never carry a match by itself.
  it('does not let a bare number resolve on the range bonus alone, with no word evidence', () => {
    const properties = [mkProperty('2203-2207-northwood-dr-salisbury-md', '2203-2207 Northwood Dr, Salisbury MD')];
    expect(resolvePropertyId('2205', properties)).toBeNull();
  });

  // Round-3 refute finding: the single-token floor (1) had no generic-word exclusion, so a key
  // that is JUST a street-type word ('Lane', 'Hwy') resolved confidently to whichever one property
  // happens to spell that word out -- reopening round 2's "one bare generic word" finding in its
  // degenerate single-token form.
  it('does not let a single bare generic street-type word resolve on its own', () => {
    const properties = [mkProperty('401-sunburst-hwy-cambridge-md', '401 Sunburst Hwy, Cambridge MD')];
    expect(resolvePropertyId('Hwy', properties)).toBeNull();
    expect(resolvePropertyId('Lane', properties)).toBeNull();
  });

  // Round-3 refute finding: a matched word that is ONLY generic ('ave', shared by many street
  // types) still cleared the floor when paired with a coincidental number match from an unrelated
  // property -- '1100 E 5th Ave' resolved to Rarig (1100 Rarig Ave) via 'ave' alone, while the
  // real '3540 E. 5th Ave' was correctly gate-disqualified by its own mismatched number. At least
  // one matched word must be non-generic for a candidate to be eligible at all.
  it('does not let a generic word plus a coincidental number resolve to an unrelated property', () => {
    const properties = [
      mkProperty('1100-rarig-ave-columbus-oh', '1100 Rarig Ave, Columbus OH'),
      mkProperty('3540-e-5th-ave-columbus-oh', '3540 E. 5th Ave, Columbus OH'),
    ];
    expect(resolvePropertyId('1100 E 5th Ave', properties)).toBeNull();
  });

  // Round-3 refute finding: a matched word that is only the address's own CITY qualifier is
  // equally non-distinctive -- '401 Cambridge Ave' resolved to Sunburst (401 Sunburst Hwy,
  // Cambridge MD) purely because 'cambridge' matched, with the real street name ('Sunburst')
  // absent from the key entirely. City tokens are derived from the address's own trailing
  // "City, ST" segment, not a hardcoded list.
  it('does not let a shared city name plus a coincidental number resolve to an unrelated street', () => {
    const properties = [mkProperty('401-sunburst-hwy-cambridge-md', '401 Sunburst Hwy, Cambridge MD')];
    expect(resolvePropertyId('401 Cambridge Ave', properties)).toBeNull();
  });

  // Round-4 refute finding: the city-segment gate used the LAST comma, correct only for the
  // sheet's current single-comma 'Street, City ST' style. The equally-standard USPS 'Street, City,
  // ST ZIP' format (already used elsewhere in this repo's own data) puts the city in the MIDDLE
  // segment, so a last-comma slice keeps only the ZIP and lets the city word regain distinctive
  // status -- reopening the exact 'Cambridge Ave' collision above. Same for a comma-less address.
  // A comma-LESS address ('401 Sunburst Hwy Cambridge MD', no comma anywhere) is a known,
  // disclosed residual, NOT fixed here: cityTokens has no structural marker to find without a
  // comma, and every one of the 14 live Properties rows uses the standard comma-separated form --
  // guessing at a city boundary without one risks misclassifying a genuine two-word street name.
  it('recognizes the city segment under the standard two-comma postal format', () => {
    const twoComma = [mkProperty('401-sunburst-hwy-cambridge-md', '401 Sunburst Hwy, Cambridge, MD 21613')];
    expect(resolvePropertyId('401 Cambridge Ave', twoComma)).toBeNull();
  });

  // Round-4 refute finding: GENERIC_WORDS covered street-type words but not spelled-out
  // directionals or unit designators -- 'north' matched a spelled-out '1900 North Broadway' as
  // the SOLE distinctive word, wrong-matching a genuinely different, unrelated 'North Ave'
  // address that merely shared a coincidental house number.
  it('does not let a spelled-out directional or unit word be the sole distinctive match', () => {
    const properties = [mkProperty('1900-n-broadway-baltimore-md', '1900 North Broadway, Baltimore MD')];
    expect(resolvePropertyId('1900 North Ave', properties)).toBeNull();
    const suiteProps = [mkProperty('3540-e-5th-ave-columbus-oh', '3540 E. 5th Ave Suite 200, Columbus OH')];
    expect(resolvePropertyId('3540 Suite', suiteProps)).toBeNull();
  });

  // Round-4 refute finding: a property whose STREET name equals its own CITY name (a real Ohio
  // naming pattern -- this portfolio already has a Westerville Rd) could never resolve ANY of its
  // leases, including a key identical to its own canonical address, because its one distinctive
  // word was always excluded as a city qualifier. A word present in BOTH the street and city
  // segments is still real street-name evidence.
  it('does not exclude a word as a city qualifier when it is also the property\'s own street name', () => {
    const properties = [mkProperty('3034-westerville-rd-westerville-oh', '3034 Westerville Rd, Westerville OH')];
    expect(resolvePropertyId('3034 Westerville Rd, Westerville OH', properties)).toBe('3034-westerville-rd-westerville-oh');
    expect(resolvePropertyId('3034 Westerville Rd', properties)).toBe('3034-westerville-rd-westerville-oh');
  });

  // cc-audit-army finding unresolved-lease-propertyid-silent: the Sepich Portfolio is tracked as
  // ONE consolidated property_master row (same target detect.ts's PROPERTY_ALIASES uses for the
  // portfolio's P&L filename token 'fvc'), so its 8 physical buildings have no per-building
  // address for the token-matching algorithm above to match against at all -- token matching can
  // never resolve these regardless of how it's tuned, hence the dedicated alias table.
  describe('RENT_ROLL_PROPERTY_ALIASES — Sepich Portfolio sub-property names', () => {
    // The alias must resolve without any address-token corroboration (none exists in
    // property_master for these sub-buildings) -- but ONLY when its target id is actually
    // present in `properties`, the same contract every other path through this function holds
    // to (see the finding below). A Sepich property_master row is present in every case here.
    const sepich = mkProperty('sepich-portfolio-columbus-oh-8-props', 'Sepich Portfolio, Columbus OH');

    it('resolves the three confirmed Sepich sub-property names to the consolidated Sepich id', () => {
      expect(resolvePropertyId('Banwick', [sepich])).toBe('sepich-portfolio-columbus-oh-8-props');
      expect(resolvePropertyId('Morrison', [sepich])).toBe('sepich-portfolio-columbus-oh-8-props');
      expect(resolvePropertyId('Zettler', [sepich])).toBe('sepich-portfolio-columbus-oh-8-props');
    });

    it('matches case-insensitively and tolerates surrounding whitespace', () => {
      expect(resolvePropertyId('  BANWICK  ', [sepich])).toBe('sepich-portfolio-columbus-oh-8-props');
      expect(resolvePropertyId('banwick', [sepich])).toBe('sepich-portfolio-columbus-oh-8-props');
    });

    // cc-audit-army code-review finding (2026-08-22): the alias previously returned its
    // hardcoded target unconditionally, with no check it actually exists in `properties` --
    // unlike every other path through this function. A renamed/retired/absent Sepich id must
    // now fall through to null (a defense-in-depth backstop against future id drift), not a
    // dangling propertyId with zero data-quality signal.
    it('falls through to null when the alias target is absent from properties (defense in depth)', () => {
      expect(resolvePropertyId('Banwick', [])).toBeNull();
      const unrelated = mkProperty('some-other-property', '1 Some Other St, Anytown OH');
      expect(resolvePropertyId('Morrison', [unrelated])).toBeNull();
    });

    // The existing 'Banwick Lane' -> null test above (round-2 refute finding) must keep passing
    // unchanged: the alias table matches the bare single-word key actually seen in the live rent
    // roll ("Banwick"), not a two-word variant, so it must not swallow that unrelated test's key.
    it('does not fire on a multi-word key that merely contains an aliased word', () => {
      const properties = [mkProperty('29000-information-lane-easton-md', '29000 Information Lane, Easton MD')];
      expect(resolvePropertyId('Banwick Lane', properties)).toBeNull();
    });

    // SUPERSEDED 2026-08-24 (Gabriel directive), evidence-based reversal of the 2026-08-21 call.
    // The alias table's original comment left '4595 E. 5th Ave' unresolved for want of "comparable
    // evidence". That evidence was subsequently located in the source of record and is conclusive:
    // 'Tax Assessment Summary -- Sepich Portfolio.xlsx' enumerates exactly EIGHT parcels -- matching
    // the property_master row's own "(8 props)" -- and parcel 010-003904-00 is literally
    // "4595-4601 E Fifth Ave / Sepich". ONE parcel spans BOTH street numbers, which is why the rent
    // roll carries two separate keys for it. Independently corroborated by the 2020 acquisition DD
    // ('Environmental Report -- 4595 - 4601 East 5th Avenue 12-2020.pdf', 'survey -- 4595 - 4601 East
    // Fifth Ave.pdf'), by the 2022 Sepich rent roll whose own header lists "4595 E 5th Ave" as a
    // portfolio property, and by 'Billboard Lease -- 4601 E. 5th Ave Sepich.pdf'. This is a STRONGER
    // corroboration record than Banwick/Morrison/Zettler carried. Do NOT re-null these on the
    // strength of the retracted comment.
    it('resolves both E. 5th Ave sub-parcel keys to the consolidated Sepich id', () => {
      expect(resolvePropertyId('4595 E. 5th Ave', [sepich])).toBe('sepich-portfolio-columbus-oh-8-props');
      expect(resolvePropertyId('4601 E. 5th Ave', [sepich])).toBe('sepich-portfolio-columbus-oh-8-props');
    });

    // The number-gate protection is NOT weakened by the aliases above. With only the unrelated
    // '3540 E. 5th Ave' property present (no Sepich row), the alias's existence-check must still
    // fall through to null rather than mis-attributing this rent to the neighbouring building --
    // the exact false positive the round-1 refute pass caught.
    it('still refuses to mis-resolve an E. 5th Ave sub-parcel onto 3540 when Sepich is absent', () => {
      const properties = [mkProperty('3540-e-5th-ave-columbus-oh', '3540 E. 5th Ave, Columbus OH')];
      expect(resolvePropertyId('4595 E. 5th Ave', properties)).toBeNull();
      expect(resolvePropertyId('4601 E. 5th Ave', properties)).toBeNull();
    });
  });
});
