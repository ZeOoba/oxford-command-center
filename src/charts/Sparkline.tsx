import { useId } from 'react';
import { LinePath, AreaClosed } from '@visx/shape';
import { scaleLinear } from '@visx/scale';
import { curveMonotoneX } from '@visx/curve';
import { LinearGradient } from '@visx/gradient';
import { sparklineSummary, type SparkFormat } from './sparkline-summary';

interface Props {
  data: number[];
  /** What the series is (and its basis). Required (roadmap 2.5): it seeds the text summary that
   *  becomes the svg's accessible name — see sparkline-summary.ts. */
  label: string;
  /** Formats the first/last values in the summary. */
  valueFormat?: SparkFormat;
  width?: number;
  height?: number;
  color?: string;
}

/** Compact branded sparkline with gradient area fill. */
export function Sparkline({ data, label, valueFormat, width = 116, height = 34, color = 'var(--accent)' }: Props) {
  const gid = useId().replace(/:/g, '');
  const summary = sparklineSummary(data, label, valueFormat);
  if (data.length < 2) return <svg width={width} height={height} role="img" aria-label={summary} />;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const x = scaleLinear({ domain: [0, data.length - 1], range: [2, width - 2] });
  const y = scaleLinear({ domain: [min, max || 1], range: [height - 3, 3] });

  return (
    <svg width={width} height={height} role="img" aria-label={summary} style={{ display: 'block', overflow: 'visible' }}>
      <LinearGradient id={`spk-${gid}`} from={color} to={color} fromOpacity={0.26} toOpacity={0} />
      <AreaClosed
        data={data}
        x={(_d, i) => x(i)}
        y={(d) => y(d)}
        yScale={y}
        curve={curveMonotoneX}
        fill={`url(#spk-${gid})`}
        stroke="none"
      />
      <LinePath
        data={data}
        x={(_d, i) => x(i)}
        y={(d) => y(d)}
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="round"
        curve={curveMonotoneX}
      />
      <circle cx={x(data.length - 1)} cy={y(data[data.length - 1]!)} r={2.2} fill={color} />
    </svg>
  );
}
