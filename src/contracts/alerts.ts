import { z } from 'zod';

export const InsightSeverityZ = z.enum(['critical', 'warning', 'info']);
export type InsightSeverityZ = z.infer<typeof InsightSeverityZ>;

export const SnoozeEntry = z.object({
  until: z.string(), // ISO timestamp; snooze expires at/after this
  severityAtSnooze: InsightSeverityZ, // escalation past this re-shows the alert
});
export type SnoozeEntry = z.infer<typeof SnoozeEntry>;

export const AlertInboxState = z.object({
  read: z.array(z.string()).default([]),
  snoozed: z.record(z.string(), SnoozeEntry).default({}),
});
export type AlertInboxState = z.infer<typeof AlertInboxState>;

export const EMPTY_INBOX_STATE: AlertInboxState = { read: [], snoozed: {} };

/** POST /api/actions/alert body. */
export const AlertActionInput = z.object({
  alertId: z.string().min(1),
  action: z.enum(['read', 'unread', 'snooze']),
  days: z.union([z.literal(7), z.literal(30)]).optional(),
  severity: InsightSeverityZ.optional(), // required for snooze (current severity)
});
export type AlertActionInput = z.infer<typeof AlertActionInput>;
