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
  /** When true, appends ?narrative=1 to the PDF route and defaults the label to
   *  "Export with narrative (PDF)". The server composes an AI narrative section before
   *  rendering the PDF. Falls back gracefully if the AI call fails (server always 200s). */
  narrative?: boolean;
}

/**
 * Renders a button that downloads a PDF briefing for a property or manager.
 *
 * @param kind - The briefing subject type: either 'property' or 'manager'.
 * @param id - The identifier (slug) of the property or manager to generate the briefing for.
 * @param narrative - When true, requests the AI narrative variant (?narrative=1). Defaults the
 *   label to "Export with narrative (PDF)". The server degrades gracefully on AI failure.
 */
export function ExportBriefingButton({
  kind,
  id,
  size = 'sm',
  label,
  narrative = false,
}: Props) {
  const defaultLabel = narrative ? 'Export with narrative (PDF)' : 'Export briefing (PDF)';
  const resolvedLabel = label ?? defaultLabel;
  const href = narrative
    ? `/api/warehouse/briefing/${kind}/${encodeURIComponent(id)}.pdf?narrative=1`
    : `/api/warehouse/briefing/${kind}/${encodeURIComponent(id)}.pdf`;
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
    <Button variant="subtle" size={size} onPress={onPress} aria-label={resolvedLabel}>
      <Download size={size === 'sm' ? 13 : 15} />
      {resolvedLabel}
    </Button>
  );
}
