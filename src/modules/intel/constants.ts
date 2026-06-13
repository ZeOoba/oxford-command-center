// src/modules/intel/constants.ts
//
// Shared display constants for the Property Financial Intelligence module.
import { Classification } from '@contracts/warehouse';
import type { BadgeTone } from '@/primitives/Badge';

/** Canonical normalized-category list (the Gabriel-ratified PFI seed taxonomy, sorted).
 *  Used by the Mappings override form's category <select>. */
export const NORMALIZED_CATEGORIES = [
  'Accounting',
  'Administrative',
  'Bad Debt',
  'CAM Recoveries',
  'Capital Expenditures',
  'Contract Services',
  'Debt Service',
  'Depreciation/Amortization',
  'Distributions',
  'Insurance',
  'Insurance Recoveries',
  'Janitorial',
  'Landscaping',
  'Leasing Commissions',
  'Legal',
  'Management Fees',
  'Marketing',
  'Miscellaneous',
  'Other Income',
  'Rental Revenue',
  'Repairs & Maintenance',
  'Snow Removal',
  'Tax Recoveries',
  'Taxes',
  'Tenant Improvements',
  'Unmapped',
  'Utilities',
] as const;

/** Classification options come straight from the contract enum (single source of truth). */
export const CLASSIFICATIONS = Classification.options;

/** Import-status → Badge tone (committed=green, pending-review=amber, superseded=neutral,
 *  rejected=red, needs-adapter=blue). */
export function statusTone(status: string): BadgeTone {
  switch (status) {
    case 'committed':
      return 'green';
    case 'pending-review':
      return 'amber';
    case 'rejected':
      return 'red';
    case 'needs-adapter':
      return 'blue';
    default: // superseded + any unknown
      return 'neutral';
  }
}

/** DQ-issue severity → Badge tone. */
export function severityTone(severity: string): BadgeTone {
  switch (severity) {
    case 'error':
    case 'critical':
      return 'red';
    case 'warning':
      return 'amber';
    default:
      return 'neutral';
  }
}
