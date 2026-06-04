import type { ReactNode } from 'react';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, rectSortingStrategy, useSortable, sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, EyeOff, Plus, RotateCcw, Pencil, Check } from 'lucide-react';
import { useSnapshot, useAnalytics } from '@/data/queries';
import { useWorkspaces } from '@/brain/useWorkspaces';
import { Skeleton } from '@/primitives/Skeleton';
import { Button } from '@/primitives/Button';
import { OVERVIEW_WIDGETS, DEFAULT_WIDGET_ORDER, type WidgetDef } from './widgets';

export function OverviewModule() {
  const { data, isLoading, isError } = useSnapshot();
  const { analytics } = useAnalytics();
  const ws = useWorkspaces(DEFAULT_WIDGET_ORDER);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  if (isError)
    return (
      <div className="grid place-items-center py-24 text-sm" style={{ color: 'var(--color-neg)' }}>
        Unable to reach the Brain Server. Is it running on :8911?
      </div>
    );
  if (isLoading || !data || !analytics) return <OverviewSkeleton />;

  const byId = Object.fromEntries(OVERVIEW_WIDGETS.map((w) => [w.id, w])) as Record<string, WidgetDef>;
  const onDragEnd = (e: DragEndEvent) => {
    if (e.over && e.active.id !== e.over.id) ws.reorder(String(e.active.id), String(e.over.id));
  };

  return (
    <div className="flex flex-col gap-4">
      <WorkspaceBar ws={ws} />
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={ws.visibleOrder} strategy={rectSortingStrategy}>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {ws.visibleOrder.map((id) => {
              const w = byId[id];
              if (!w) return null;
              const W = w.Component;
              return (
                <SortableWidget key={id} id={id} span={w.span} editMode={ws.editMode} onHide={() => ws.hide(id)}>
                  <W />
                </SortableWidget>
              );
            })}
          </div>
        </SortableContext>
      </DndContext>
    </div>
  );
}

function WorkspaceBar({ ws }: { ws: ReturnType<typeof useWorkspaces> }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-1.5">
        {ws.workspaceNames.map((name) => (
          <button
            key={name}
            onClick={() => ws.setActive(name)}
            className="num rounded-full px-3 py-1 text-2xs font-semibold transition-colors"
            style={
              name === ws.active
                ? { background: 'var(--accent-quiet)', border: '1px solid color-mix(in oklab, var(--accent) 40%, transparent)', color: 'var(--accent)' }
                : { background: 'transparent', border: '1px solid var(--border-subtle)', color: 'var(--text-tertiary)' }
            }
          >
            {name}
          </button>
        ))}
        <button
          onClick={() => ws.saveAs(`View ${ws.workspaceNames.length + 1}`)}
          className="flex items-center gap-1 rounded-full px-2.5 py-1 text-2xs transition-colors"
          style={{ border: '1px solid var(--border-subtle)', color: 'var(--text-tertiary)' }}
        >
          <Plus size={11} /> New view
        </button>
      </div>

      <div className="flex items-center gap-2">
        {ws.editMode &&
          ws.hiddenIds.map((id) => (
            <button
              key={id}
              onClick={() => ws.show(id)}
              className="num rounded-[var(--radius-sm)] px-2 py-1 text-2xs transition-colors"
              style={{ background: 'var(--surface-overlay)', border: '1px dashed var(--border-strong)', color: 'var(--text-secondary)' }}
            >
              + {OVERVIEW_WIDGETS.find((w) => w.id === id)?.title ?? id}
            </button>
          ))}
        {ws.editMode && (
          <Button size="sm" variant="ghost" onPress={ws.resetActive}>
            <RotateCcw size={13} /> Reset
          </Button>
        )}
        <Button size="sm" variant={ws.editMode ? 'primary' : 'subtle'} onPress={() => ws.setEditMode(!ws.editMode)}>
          {ws.editMode ? <Check size={13} /> : <Pencil size={13} />}
          {ws.editMode ? 'Done' : 'Edit layout'}
        </Button>
      </div>
    </div>
  );
}

function SortableWidget({ id, span, editMode, onHide, children }: { id: string; span: 'full' | 'half'; editMode: boolean; onHide: () => void; children: ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id, disabled: !editMode });
  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        gridColumn: span === 'full' ? '1 / -1' : undefined,
        opacity: isDragging ? 0.55 : 1,
        zIndex: isDragging ? 10 : undefined,
      }}
      className="relative"
    >
      {editMode && (
        <div className="absolute right-2 top-2 z-20 flex items-center gap-1 rounded-[var(--radius-sm)] p-0.5" style={{ background: 'var(--surface-overlay)', border: '1px solid var(--border-strong)' }}>
          <button {...attributes} {...listeners} aria-label="Drag widget" className="grid h-6 w-6 cursor-grab place-items-center rounded" style={{ color: 'var(--text-secondary)' }}>
            <GripVertical size={13} />
          </button>
          <button onClick={onHide} aria-label="Hide widget" className="grid h-6 w-6 place-items-center rounded" style={{ color: 'var(--text-secondary)' }}>
            <EyeOff size={13} />
          </button>
        </div>
      )}
      {editMode && <div className="pointer-events-none absolute inset-0 z-10 rounded-[var(--radius-lg)]" style={{ border: '1px dashed color-mix(in oklab, var(--accent) 40%, transparent)' }} />}
      {children}
    </div>
  );
}

function OverviewSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} style={{ height: 96 }} />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Skeleton style={{ height: 300 }} />
        <Skeleton style={{ height: 300 }} />
      </div>
    </div>
  );
}
