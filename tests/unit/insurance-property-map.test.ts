import { describe, expect, it } from 'vitest';
import { resolveInsuranceProperty } from '../../server/warehouse/insurance-property-map';

const master = new Map([
  ['9620-e-state-route-350-raytown-mo', '9620 E State Route 350, Raytown MO'],
  ['sepich-portfolio-columbus-oh-8-props', 'FVC — Fairground Village Center / Sepich Portfolio (8 props)'],
  ['3875-3883-e-livingston-ave-columbus-oh', '3875-3883 E Livingston Ave, Columbus OH'],
]);

describe('resolveInsuranceProperty', () => {
  it('maps a policy-line key (stem + line suffix) to the property master name', () => {
    expect(resolveInsuranceProperty('ins-9620state350-prop-hfd', master)).toEqual({
      propertyId: '9620-e-state-route-350-raytown-mo', name: '9620 E State Route 350, Raytown MO' });
    expect(resolveInsuranceProperty('ins-fvc-bcl', master).propertyId).toBe('sepich-portfolio-columbus-oh-8-props');
    expect(resolveInsuranceProperty('ins-3883livingston-pckg', master).name).toBe('3875-3883 E Livingston Ave, Columbus OH');
  });
  it('label-only stems with no master row still read as an address', () => {
    expect(resolveInsuranceProperty('ins-etcpoa-pckg', master)).toEqual({ propertyId: null, name: 'Airport Road, Easton MD (ETC POA)' });
  });
  it('unknown keys fall back to the raw key', () => {
    expect(resolveInsuranceProperty('ins-unknown-gl', master)).toEqual({ propertyId: null, name: 'ins-unknown-gl' });
  });
});
