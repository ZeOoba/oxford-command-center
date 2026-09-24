// Split out of RenewalsModule.tsx (Task 4) — a non-component export in a component file trips
// react-refresh/only-export-components ("Fast refresh only works when a file only exports
// components"). Keeping it here lets RenewalsModule.tsx export only the component again while
// still sharing the label with its unit test.
export const dayLabel = (d: number | null) =>
  d === null ? '—' : d < 0 ? `Holdover · ${Math.abs(d)}d` : `${d}d`;
