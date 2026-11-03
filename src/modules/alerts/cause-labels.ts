import type { TierItem } from '@/primitives/TierBoard';
import { ALERT_THRESHOLDS } from '@/analytics/conditions';
import { fmtPct } from '@/analytics/format';

/** Row title for a rolled-up alert cause. Unknown causes still read sensibly. */
export function describeAlertCause(cause: string, members: TierItem[]): { title: string } {
  const n = members.length;
  switch (cause) {
    case 'lease-expiry-no-signal':
      return { title: `${n} leases expiring ≤90d with no renewal signal` };
    case 'lease-lapsed':
      return { title: `${n} leases past end date with no executed renewal (month-to-month or holdover)` };
    case 'lease-expiry-imminent':
      return { title: `${n} leases expiring within 7d with no renewal signal` };
    case 'lease-expiring-soon': {
      // ≤90d no-signal leases route to their own cause, so this group usually starts past 90d; name
      // the band its members actually span rather than a window it does not fill.
      const band = dayBand(members);
      return { title: band ? `${n} leases expiring in ${band}` : `${n} leases expiring within 180d` };
    }
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
    case 'dscr-floor':
      return { title: `${n} properties below the DSCR floor` };
    case 'dscr-covenant':
      return { title: `${n} properties on DSCR covenant watch` };
    case 'ltv-ceiling':
      return { title: `${n} properties above the ${fmtPct(ALERT_THRESHOLDS.refiLtvCeilingPerProperty, 0)} LTV ceiling` };
    default:
      return { title: `${n} related alerts` };
  }
}

/** "92–151d" across members that all carry a day count; null when any does not. */
function dayBand(members: TierItem[]): string | null {
  const days = members.map((m) => m.daysToAct);
  if (days.length === 0 || days.some((d) => d === undefined)) return null;
  const lo = Math.min(...(days as number[]));
  const hi = Math.max(...(days as number[]));
  return lo === hi ? `${lo}d` : `${lo}–${hi}d`;
}
