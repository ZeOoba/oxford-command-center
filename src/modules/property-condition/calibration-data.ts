// src/modules/property-condition/calibration-data.ts
//
// The committed calibration ledger + pending proposals, validated against the strict schema at load. Adding a row
// to data/calibration/observations.json (via `npm run calibration:promote`) is a data change — no code edits.
import { parseLedger, parsePending } from '@/analytics/calibration-ledger';
import observationsRaw from '../../../data/calibration/observations.json';
import pendingRaw from '../../../data/calibration/calibration_pending.json';

export const CALIBRATION_LEDGER = parseLedger(observationsRaw);
export const CALIBRATION_PENDING = parsePending(pendingRaw);
