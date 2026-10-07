import type { TierItem } from '@/primitives/TierBoard';

/** Row title for a rolled-up alert cause. Unknown causes still read sensibly. */
export function describeAlertCause(cause: string, members: TierItem[]): { title: string } {
  const n = members.length;
  switch (cause) {
    case 'lease-expiry-no-signal':
      return { title: `${n} leases expiring ≤90d with no renewal signal` };
    case 'lease-lapsed':
      return { title: `${n} leases on holdover with no executed renewal` };
    case 'lease-expiring-soon':
      return { title: `${n} leases expiring within 180d` };
    case 'lease-expired':
      return { title: `${n} leases expired and holding over` };
    case 'lease-mtm':
      return { title: `${n} month-to-month tenants with no fixed end` };
    case 'lease-undermarket':
      return { title: `${n} leases below market rent` };
    case 'escalation-passed':
      return { title: `${n} rent escalations past due` };
    case 'insurance-lapsed':
      return { title: `${n} insurance policies expired or cancelled` };
    default:
      return { title: `${n} related alerts` };
  }
}
