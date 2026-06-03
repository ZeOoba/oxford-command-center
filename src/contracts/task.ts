import { z } from 'zod';

export const TaskStatus = z.enum(['done', 'overdue', 'renewal', 'pending', 'na', 'unknown']);
export type TaskStatus = z.infer<typeof TaskStatus>;

/** A monthly operations checklist item. Source: master workbook `Monthly Checklist`. */
export const Task = z.object({
  id: z.string(),
  label: z.string(),
  section: z.string(),
  role: z.string().nullable(),
  type: z.string().nullable(),
  dueDay: z.string().nullable(),
  notes: z.string().nullable(),
  status: TaskStatus,
  monthlyPmt: z.number().nullable(),
});
export type Task = z.infer<typeof Task>;
