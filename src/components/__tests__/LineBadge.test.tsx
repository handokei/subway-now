import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { LineBadge, getLineColor, getLineLabel } from '../LineBadge';
import { colors } from '../../theme';

describe('LineBadge', () => {
  it('should render line label for known numeric lines', () => {
    render(<LineBadge line="2" />);
    expect(screen.getByText('2호선')).toBeTruthy();
  });

  it('should render line label for special lines', () => {
    render(<LineBadge line="airport" />);
    expect(screen.getByText('공항철도')).toBeTruthy();
  });

  it('should fallback to LINE label for unknown lines', () => {
    render(<LineBadge line="unknown" />);
    expect(screen.getByText('LINE unknown')).toBeTruthy();
  });

  it('should use provided color override', () => {
    render(<LineBadge line="1" color="#FF0000" />);
    expect(screen.getByText('1호선')).toBeTruthy();
  });
});

describe('getLineColor', () => {
  it('should return correct color for known lines', () => {
    expect(getLineColor('1')).toBe('#0052A4');
    expect(getLineColor('6')).toBe('#CD7C2F');
  });

  it('should return accent color for unknown lines', () => {
    expect(getLineColor('unknown')).toBe(colors.accent);
  });
});

describe('getLineLabel', () => {
  it('should return Korean name for known lines', () => {
    expect(getLineLabel('1')).toBe('1호선');
    expect(getLineLabel('airport')).toBe('공항철도');
  });

  it('should return LINE fallback for unknown lines', () => {
    expect(getLineLabel('unknown')).toBe('LINE unknown');
  });
});
