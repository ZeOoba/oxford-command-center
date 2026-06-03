import { MacroSnapshot } from '@contracts/index';

export async function fetchMacro(): Promise<MacroSnapshot> {
  try {
    const res = await fetch('/api/macro');
    if (res.ok) return MacroSnapshot.parse(await res.json());
  } catch {
    /* server offline — try the static mirror */
  }
  const res = await fetch('/macro.json');
  if (!res.ok) throw new Error('No macro data available.');
  return MacroSnapshot.parse(await res.json());
}
