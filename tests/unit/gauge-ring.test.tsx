import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { GaugeRing } from '../../src/primitives/GaugeRing';

afterEach(() => cleanup());

function ringCircles(container: HTMLElement): { track: SVGCircleElement; progress: SVGCircleElement } {
  const circles = container.querySelectorAll('circle');
  const track = circles[0] as SVGCircleElement | undefined;
  const progress = circles[1] as SVGCircleElement | undefined;
  if (!track || !progress) throw new Error('expected two circle elements');
  return { track, progress };
}

function circumferenceOf(track: SVGCircleElement): number {
  return 2 * Math.PI * Number(track.getAttribute('r'));
}

describe('GaugeRing / dashoffset math', () => {
  it('renders a full dashoffset (empty ring) at value 0', () => {
    const { container } = render(<GaugeRing value={0} max={100} />);
    const { track, progress } = ringCircles(container);
    const c = circumferenceOf(track);
    expect(Number(progress.getAttribute('stroke-dashoffset'))).toBeCloseTo(c, 5);
  });

  it('renders a half-offset ring at value 50 of 100', () => {
    const { container } = render(<GaugeRing value={50} max={100} />);
    const { track, progress } = ringCircles(container);
    const c = circumferenceOf(track);
    expect(Number(progress.getAttribute('stroke-dashoffset'))).toBeCloseTo(c * 0.5, 5);
  });

  it('renders a zero dashoffset (full ring) at value 100 of 100', () => {
    const { container } = render(<GaugeRing value={100} max={100} />);
    const { progress } = ringCircles(container);
    expect(Number(progress.getAttribute('stroke-dashoffset'))).toBeCloseTo(0, 5);
  });

  it('clamps a value above max to a zero dashoffset', () => {
    const { container } = render(<GaugeRing value={140} max={100} />);
    const { progress } = ringCircles(container);
    expect(Number(progress.getAttribute('stroke-dashoffset'))).toBeCloseTo(0, 5);
  });

  it('honors a custom max when computing the ratio', () => {
    const { container } = render(<GaugeRing value={5} max={10} />);
    const { track, progress } = ringCircles(container);
    const c = circumferenceOf(track);
    expect(Number(progress.getAttribute('stroke-dashoffset'))).toBeCloseTo(c * 0.5, 5);
  });
});

describe('GaugeRing / numeral + label', () => {
  it('renders the rounded value as a large numeral', () => {
    render(<GaugeRing value={72.4} max={100} />);
    expect(screen.getByText('72')).toBeTruthy();
  });

  it('renders an optional label under the numeral', () => {
    render(<GaugeRing value={72} max={100} label="Buy-box score" />);
    expect(screen.getByText('Buy-box score')).toBeTruthy();
  });

  it('omits the label element when none is given', () => {
    const { container } = render(<GaugeRing value={72} max={100} />);
    expect(container.querySelectorAll('span.num').length).toBe(1);
  });
});
