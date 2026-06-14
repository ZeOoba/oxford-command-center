// src/modules/intel/ExportBriefingButton.tsx
//
// "Export briefing (PDF)" action for the Intelligence module (PFI Phase C). CLIENT-ONLY and DEP-LIGHT:
// it does NOT import @react-pdf/renderer or any font package — it just points the browser at the
// server's streaming `.pdf` route, which responds with Content-Disposition: attachment. So the heavy
// PDF/font deps stay entirely server-side and never enter the client bundle (bundle-budget safe).
//
// On the deployed static mirror the warehouse routes 503; the button still renders but the download
// yields the 503 body — the page itself already shows the offline Card upstream, so this is a
// no-op there, not a crash.
import { Download } from 'lucide-react';
import { Button } from '@/primitives/Button';

interface Props {
  /** 'property' → /briefing/property/:id.pdf · 'manager' → /briefing/manager/:id.pdf */
  kind: 'property' | 'manager';
  /** The subject id: a property slug, or a manager slug (managerSlug of the PM name). */
  id: string;
  size?: 'sm' | 'md';
  label?: string;
}

export function ExportBriefingButton({ kind, id, size = 'sm', label = 'Export briefing (PDF)' }: Props) {
  const href = `/api/warehouse/briefing/${kind}/${encodeURIComponent(id)}.pdf`;
  const onPress = () => {
    // Navigate via a transient anchor so the attachment download fires without leaving the SPA.
    const a = document.createElement('a');
    a.href = href;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  };
  return (
    <Button variant="subtle" size={size} onPress={onPress} aria-label={label}>
      <Download size={size === 'sm' ? 13 : 15} />
      {label}
    </Button>
  );
}
