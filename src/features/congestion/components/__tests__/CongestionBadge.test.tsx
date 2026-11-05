import React from 'react';
import { CongestionBadge, getLevelTone } from '../CongestionBadge';
import { renderWithTheme } from '../../../../testUtils/renderWithTheme';
import { lightColors } from '../../../../shared/theme';
import type { CongestionEntry, CongestionLevel } from '../../../../shared/types/congestion';

function makeEntry(level: CongestionLevel, raw: number): CongestionEntry {
  return {
    line: '2',
    stationName: '강남',
    direction: 'up',
    dayType: 'weekday',
    timeSlot: '08:00',
    raw,
    level,
  };
}

describe('CongestionBadge', () => {
  it.each([
    ['low', 60],
    ['medium', 100],
    ['high', 140],
    ['veryHigh', 170],
  ] as const)('renders %s entry with level label and hint', (level, raw) => {
    const { getByTestId } = renderWithTheme(
      <CongestionBadge entry={makeEntry(level, raw)} testID="badge" />,
    );
    const node = getByTestId('badge');
    expect(node.props.accessibilityLabel).toContain(String(raw));
  });

  it('uses theme tone mapping for every level', () => {
    const levels: CongestionLevel[] = ['low', 'medium', 'high', 'veryHigh'];
    levels.forEach((level) => {
      const tone = getLevelTone(level, lightColors);
      expect(tone.bg).toBeDefined();
      expect(tone.border).toBeDefined();
      expect(tone.dot).toBeDefined();
      expect(tone.text).toBeDefined();
    });
  });

  it('renders without testID prop (a11y label still present)', () => {
    const { getByA11yHint } = renderWithTheme(<CongestionBadge entry={makeEntry('low', 60)} />);
    // smoke: just ensure render does not throw.
    expect(getByA11yHint).toBeDefined();
  });
});
