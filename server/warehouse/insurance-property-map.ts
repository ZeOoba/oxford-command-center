/**
 * Insurance rows are keyed by policy line ('ins-<stem>-<line>'), not property_master.id, so the
 * LEFT JOIN in buildInsuranceAnalysis never matched and the UI showed raw keys (2026-09-23 review).
 * Explicit stem table — deterministic, reviewable; add a row when a new insured location appears.
 */
const STEM_TO_MASTER: Record<string, string> = {
  '1100rarig': '1100-rarig-ave-columbus-oh',
  '1851southclub': '1851-s-club-solar',
  '1900broadway': '1900-n-broadway-baltimore-md',
  '2203northwood': '2203-2207-northwood-dr-salisbury-md',
  '29000info': '29000-information-lane-easton-md',
  '3034westerville': '3034-westerville-rd-columbus-oh',
  '3540fifth': '3540-e-5th-ave-columbus-oh',
  '3883livingston': '3875-3883-e-livingston-ave-columbus-oh',
  '401sunburst': '401-sunburst-hwy-cambridge-md',
  '55newplant': '55-new-plant-ct-owings-mills-md',
  '7658fishel': '7658-fishel-dr-n-dublin-oh',
  '9050redbranch': '9050-red-branch-rd-columbia-md',
  '9620state350': '9620-e-state-route-350-raytown-mo',
  fvc: 'sepich-portfolio-columbus-oh-8-props',
};
/** Insured locations with no property_master row (label only). */
const STEM_LABEL_ONLY: Record<string, string> = {
  etcpoa: 'Airport Road, Easton MD (ETC POA)',
};

export function resolveInsuranceProperty(
  policyKey: string,
  masterNames: ReadonlyMap<string, string>,
): { propertyId: string | null; name: string } {
  const stem = /^ins-([a-z0-9]+)-/.exec(policyKey)?.[1];
  if (stem) {
    const id = STEM_TO_MASTER[stem];
    const name = id ? masterNames.get(id) : undefined;
    if (id && name) return { propertyId: id, name };
    const label = STEM_LABEL_ONLY[stem];
    if (label) return { propertyId: null, name: label };
  }
  return { propertyId: null, name: policyKey };
}
