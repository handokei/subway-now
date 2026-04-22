import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { EditorialArrivalRow } from '../EditorialArrivalRow';
import { makeArrivalTrain } from '../../testUtils/fixtures';

describe('EditorialArrivalRow', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  const baseTrain = { direction: '봉화산 방면', line: '6', arrivalAtMs: 1_000_000 + 134 * 1000 };

  it('should render countdown mm:ss', () => {
    render(<EditorialArrivalRow train={makeArrivalTrain(baseTrain)} />);
    expect(screen.getByText('02')).toBeTruthy();
    expect(screen.getByText('14')).toBeTruthy();
  });

  it('should render direction text', () => {
    render(<EditorialArrivalRow train={makeArrivalTrain({ ...baseTrain, arrivalAtMs: 1_000_000 + 60000 })} />);
    expect(screen.getByText('봉화산 방면')).toBeTruthy();
  });

  it('should render subtext when provided', () => {
    render(<EditorialArrivalRow train={makeArrivalTrain({ direction: '응암 방면', line: '6', arrivalAtMs: 1_000_000 + 271000, subtext: '전역 출발' })} />);
    expect(screen.getByText('전역 출발')).toBeTruthy();
  });

  it('should not render subtext when not provided', () => {
    render(<EditorialArrivalRow train={makeArrivalTrain({ ...baseTrain, arrivalAtMs: 1_000_000 + 60000 })} />);
    expect(screen.queryByText('전역 출발')).toBeNull();
  });

  it('should render line label for numeric lines', () => {
    render(<EditorialArrivalRow train={makeArrivalTrain({ ...baseTrain, arrivalAtMs: 1_000_000 + 60000 })} />);
    expect(screen.getByText('6호선')).toBeTruthy();
  });

  it('should render line label for special lines', () => {
    render(<EditorialArrivalRow train={makeArrivalTrain({ direction: '인천공항 방면', line: 'airport', arrivalAtMs: 1_000_000 + 600000 })} />);
    expect(screen.getByText('공항철도')).toBeTruthy();
  });

  it('should fallback to LINE label for unknown lines', () => {
    render(<EditorialArrivalRow train={makeArrivalTrain({ direction: '방면', line: 'unknown', arrivalAtMs: 1_000_000 + 60000 })} />);
    expect(screen.getByText('LINE unknown')).toBeTruthy();
  });

  it('should have testID', () => {
    render(<EditorialArrivalRow train={makeArrivalTrain({ ...baseTrain, arrivalAtMs: 1_000_000 + 60000 })} />);
    expect(screen.getByTestId('editorial-arrival-row')).toBeTruthy();
  });
});
