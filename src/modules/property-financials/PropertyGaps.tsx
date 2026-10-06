// src/modules/property-financials/PropertyGaps.tsx
//
// "Known gaps" block for one property (plan T8), used by the Explorer detail and the Scorecard row
// detail: the dataset's data_quality items that name the property, partial lease reads and (FVC) the
// square-footage inference — each tagged with its source, inferences marked [INFERRED]. Matching lives
// in data-health.ts (gapsForEntity). Links to the full data-health panel in the Data destination.
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import type { PfDataset, PfEntityId } from '@contracts/property-financials';
import { PF_DATA_HEALTH_HREF } from '../data/tabs';
import { gapsForEntity, type PfGapSource } from './data-health';

const SOURCE_LABEL: Readonly<Record<PfGapSource, string>> = {
  data_quality: 'Data quality',
  lease: 'Lease read',
  mapping: 'SF mapping',
};

export function PropertyGaps({ dataset, id, omitMapping = false }: { dataset: PfDataset; id: PfEntityId; omitMapping?: boolean }) {
  const gaps = useMemo(() => gapsForEntity(dataset, id).filter((g) => !(omitMapping && g.source === 'mapping')), [dataset, id, omitMapping]);
  if (gaps.length === 0) return null;
  return (
    <section className="pf-gaps" data-testid="pf-gaps" aria-label="Known data gaps for this property">
      <h4 className="pf-h4">Known data gaps</h4>
      <ul>
        {gaps.map((g) => (
          <li key={`${g.source}:${g.text}`}>
            <span className="pf-gaps-src">{SOURCE_LABEL[g.source]}</span>
            {g.inferred && (
              <span className="pf-inferred" title="Inferred by reconciliation, not read from a property-level source">
                [INFERRED]
              </span>
            )}
            {g.text}
          </li>
        ))}
      </ul>
      <Link className="pf-note" to={PF_DATA_HEALTH_HREF}>
        All gaps and the mapping table: data health
      </Link>
    </section>
  );
}
