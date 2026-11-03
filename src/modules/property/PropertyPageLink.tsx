// src/modules/property/PropertyPageLink.tsx
//
// The one link into the canonical property page (roadmap 2.2), used by the property table, the
// Property Financials explorer and the alerts boards. Carries ?scenario/?still like every other
// in-app jump, and stops the click so a host row's own handler (open the drawer) does not also fire.
import type { ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { propertyPageHref } from './property-page-model';

export function PropertyPageLink({ propertyId, children = 'Open property page →' }: { propertyId: string; children?: ReactNode }) {
  const location = useLocation();
  return (
    <Link
      to={propertyPageHref(propertyId, location.search)}
      onClick={(e) => e.stopPropagation()}
      className="text-2xs font-semibold"
      style={{ color: 'var(--accent)' }}
    >
      {children}
    </Link>
  );
}
