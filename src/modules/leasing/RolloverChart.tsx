import { BarChart } from '@/charts/BarChart';
import { useAnalytics } from '@/data/queries';
import { fmtUsdCompact } from '@/analytics/format';
import { Card, CardHeader } from '@/primitives/Card';
import { Badge } from '@/primitives/Badge';
import { rolloverChartData } from './rollover-chart-data';

// rolloverChartData lives in ./rollover-chart-data.ts (not re-exported here): react-refresh/
// only-export-components forbids a non-component export from a file that also exports a
// component. Import the pure mapper directly from there.

export function RolloverChart({ height = 230 }: { height?: number }) {
  const { analytics } = useAnalytics();
  if (!analytics) return null;
  return (
    <Card>
      <CardHeader title="Lease Rollover" trailing={<Badge tone="neutral">rent expiring by period</Badge>} />
      <div className="px-3 pb-2 pt-3">
        <BarChart
          data={rolloverChartData(analytics.rollover)}
          valueFormat={fmtUsdCompact}
          height={height}
          color="var(--color-info)"
          ariaLabel="Lease rollover — rent expiring by period"
        />
      </div>
    </Card>
  );
}
