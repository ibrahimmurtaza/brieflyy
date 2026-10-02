import { describe, expect, it } from 'vitest';

import { sparklineSvg, volumeChartSvg } from './chart.js';
import type { TrendVolumePoint } from '../domain/types.js';

/** Every number that could reach the SVG, so a `NaN` in the markup is visible. */
function numbersIn(markup: string): number[] {
  return [...markup.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
}

function days(count: number, from = 1): TrendVolumePoint[] {
  return Array.from({ length: count }, (_, i) => ({
    date: `2024-06-${String(from + i).padStart(2, '0')}`,
    articles: i + 1,
    stories: 1,
  }));
}

describe('volumeChartSvg', () => {
  it('draws one line for Articles and one for Stories', () => {
    const svg = volumeChartSvg({ volume: days(5), spikeDates: [] });
    expect(svg).toContain('<svg');
    expect(svg.match(/<polyline/g)).toHaveLength(2);
  });

  it('never puts a non-finite number in the markup', () => {
    // A flat series divides by a maximum of zero, and a single day divides by
    // zero points. Both are ordinary — a quiet Topic, a brand new one — and both
    // used to reach the page as `NaN,NaN`, which is not a coordinate.
    const flat = volumeChartSvg({
      volume: days(6).map((d) => ({ ...d, articles: 0, stories: 0 })),
      spikeDates: [],
    });
    const single = volumeChartSvg({
      volume: [{ date: '2024-06-14', articles: 3, stories: 1 }],
      spikeDates: [],
    });
    const empty = volumeChartSvg({ volume: [], spikeDates: [] });

    for (const markup of [flat, single, empty]) {
      expect(numbersIn(markup).every(Number.isFinite)).toBe(true);
      expect(markup).not.toContain('NaN');
    }
  });

  it('marks each spike day, and only those', () => {
    const svg = volumeChartSvg({
      volume: days(6),
      spikeDates: ['2024-06-03', '2024-06-04'],
    });
    expect(svg.match(/class="spike-marker"/g)).toHaveLength(2);
    expect(volumeChartSvg({ volume: days(6), spikeDates: [] })).not.toContain('spike-marker');
  });

  it('says what it is in words, because a chart is not read by everyone', () => {
    const svg = volumeChartSvg({ volume: days(6), spikeDates: [] });
    expect(svg).toContain('role="img"');
    expect(svg).toMatch(/aria-label="[^"]+"/);
  });
});

describe('sparklineSvg', () => {
  it('is decoration, with the numbers beside it rather than inside it', () => {
    const svg = sparklineSvg({
      points: [
        { date: '2024-06-13', mentions: 1 },
        { date: '2024-06-14', mentions: 4 },
      ],
    });
    expect(svg).toContain('aria-hidden="true"');
    expect(svg).not.toContain('NaN');
  });

  it('draws a flat line for a series that never moves', () => {
    const svg = sparklineSvg({
      points: [
        { date: '2024-06-13', mentions: 2 },
        { date: '2024-06-14', mentions: 2 },
      ],
    });
    expect(svg).not.toContain('NaN');
    expect(svg).toContain('<polyline');
  });
});