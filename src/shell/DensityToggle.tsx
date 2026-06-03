import { useState } from 'react';
import { Rows3, Rows2 } from 'lucide-react';
import { Button } from '@/primitives/Button';
import { applyDensity, getInitialDensity, type Density } from '@/lib/density';

export function DensityToggle() {
  const [density, setDensity] = useState<Density>(getInitialDensity);
  const toggle = () => {
    const next: Density = density === 'comfortable' ? 'compact' : 'comfortable';
    applyDensity(next);
    setDensity(next);
  };
  return (
    <Button variant="ghost" size="sm" aria-label={`Density: ${density} (toggle)`} onPress={toggle}>
      {density === 'comfortable' ? <Rows3 size={15} /> : <Rows2 size={15} />}
    </Button>
  );
}
