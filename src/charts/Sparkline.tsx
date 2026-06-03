import { useId } from 'react';
import { LinePath, AreaClosed } from '@visx/shape';
import { scaleLinear } from '@visx/scale';
import { curveMonotoneX } from '@visx/curve';
import { LinearGradient } from '@visx/gradient';

interface Props {
  data: number[];
  width?: number;
  height?: number;
  color?: string;
}

/** Compact branded sparkline with gradient area fill. */
export function Sparkline({ data, width = 116, height = 34, color = 'var(--accent)' }: Props) {
  const gid = useId().replace(/:/g, '');
  if (data.length < 2) return <svg width={width} height={height} />;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const x = scaleLinear({ domain: [0, data.length - 1], range: [2, width - 2] });
  const y = scaleLinear({ domain: [min, max || 1], range: [height - 3, 3] });

  return (
    <svg width={width} height={height} style={{ display: 'block', overflow: 'visible' }}>
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
