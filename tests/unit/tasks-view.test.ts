import { describe, it, expect } from 'vitest';
import type { Task } from '@contracts/index';
import { buildSectionViews, OPEN_PER_SECTION } from '../../src/modules/tasks/tasks-view';

const t = (id: string, section: string, status: Task['status'], type: string | null = null): Task =>
  ({ id, label: id, section, role: null, type, dueDay: null, notes: null, status, monthlyPmt: null }) as Task;

describe('buildSectionViews', () => {
  it('keeps sections in first-seen order among those with open work', () => {
    const v = buildSectionViews([t('a', 'Taxes', 'pending'), t('b', 'Insurance', 'pending'), t('c', 'Taxes', 'done')]);
    expect(v.map((s) => s.section)).toEqual(['Taxes', 'Insurance']);
  });

  it('sends fully-complete sections after those with open work, keeping relative order', () => {
    const v = buildSectionViews([
      t('a', 'Done One', 'done'),
      t('b', 'Active One', 'pending'),
      t('c', 'Done Two', 'done'),
      t('d', 'Active Two', 'overdue'),
    ]);
    expect(v.map((s) => s.section)).toEqual(['Active One', 'Active Two', 'Done One', 'Done Two']);
  });

  it('shows only the next three open items per section', () => {
    const tasks = Array.from({ length: 8 }, (_, i) => t(`p${i}`, 'Insurance', 'pending'));
    const [s] = buildSectionViews(tasks);
    expect(OPEN_PER_SECTION).toBe(3);
    expect(s!.shown.map((x) => x.id)).toEqual(['p0', 'p1', 'p2']);
    expect(s!.heldBack).toBe(5);
    expect(s!.open).toHaveLength(8);
  });

  it('orders open work overdue first, then renewal, then pending', () => {
    const [s] = buildSectionViews([
      t('p', 'S', 'pending'),
      t('r', 'S', 'renewal'),
      t('o', 'S', 'overdue'),
      t('p2', 'S', 'pending'),
    ]);
    expect(s!.open.map((x) => x.id)).toEqual(['o', 'r', 'p', 'p2']);
  });

  it('folds completed and not-applicable items away from the open list', () => {
    const [s] = buildSectionViews([t('d', 'S', 'done'), t('n', 'S', 'na'), t('p', 'S', 'pending')]);
    expect(s!.open.map((x) => x.id)).toEqual(['p']);
    expect(s!.folded.map((x) => x.id).sort()).toEqual(['d', 'n']);
  });

  it('keeps progress as done/total so the header still reads like before', () => {
    const [s] = buildSectionViews([t('d1', 'S', 'done'), t('d2', 'S', 'done'), t('p', 'S', 'pending')]);
    expect(s!.doneCount).toBe(2);
    expect(s!.total).toBe(3);
  });

  it('marks a section made entirely of M365 To-Do items as an external feed', () => {
    const views = buildSectionViews([
      t('m1', 'Microsoft 365', 'pending', 'M365 To-Do'),
      t('m2', 'Microsoft 365', 'pending', 'M365 To-Do'),
      t('x', 'Insurance', 'pending', 'Monthly'),
    ]);
    expect(views.find((v) => v.section === 'Microsoft 365')!.external).toBe(true);
    expect(views.find((v) => v.section === 'Insurance')!.external).toBe(false);
  });

  it('does not treat a mixed section as an external feed', () => {
    const [s] = buildSectionViews([t('m1', 'Mixed', 'pending', 'M365 To-Do'), t('x', 'Mixed', 'pending', 'Monthly')]);
    expect(s!.external).toBe(false);
  });

  it('reports no held-back items when the open list fits', () => {
    const [s] = buildSectionViews([t('a', 'S', 'pending'), t('b', 'S', 'pending')]);
    expect(s!.heldBack).toBe(0);
  });
});
