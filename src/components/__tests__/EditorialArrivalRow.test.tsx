import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { EditorialArrivalRow } from '../EditorialArrivalRow';
import type { ArrivalTrain } from '../../utils/journeyAdapter';

describe('EditorialArrivalRow', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('should render countdown mm:ss', () => {
    const train: ArrivalTrain = {
      direction: '봉화산 방면',
      line: '6',
      arrivalAtMs: 1_000_000 + 134 * 1000, // 02:14
    };

    render(<EditorialArrivalRow train={train} />);
    expect(screen.getByText('02')).toBeTruthy();
    expect(screen.getByText('14')).toBeTruthy();
  });

  it('should render direction text', () => {
    const train: ArrivalTrain = {
      direction: '봉화산 방면',
      line: '6',
      arrivalAtMs: 1_000_000 + 60 * 1000,
    };

    render(<EditorialArrivalRow train={train} />);
    expect(screen.getByText('봉화산 방면')).toBeTruthy();
  });

  it('should render subtext when provided', () => {
    const train: ArrivalTrain = {
      direction: '응암 방면',
      line: '6',
      arrivalAtMs: 1_000_000 + 271 * 1000,
      subtext: '전역 출발',
    };

    render(<EditorialArrivalRow train={train} />);
    expect(screen.getByText('전역 출발')).toBeTruthy();
  });

  it('should not render subtext when not provided', () => {
    const train: ArrivalTrain = {
      direction: '봉화산 방면',
      line: '6',
      arrivalAtMs: 1_000_000 + 60 * 1000,
    };

    render(<EditorialArrivalRow train={train} />);
    expect(screen.queryByText('전역 출발')).toBeNull();
  });

  it('should render line label for numeric lines', () => {
    const train: ArrivalTrain = {
      direction: '봉화산 방면',
      line: '6',
      arrivalAtMs: 1_000_000 + 60 * 1000,
    };

    render(<EditorialArrivalRow train={train} />);
    expect(screen.getByText('6호선')).toBeTruthy();
  });

  it('should render line label for special lines', () => {
    const train: ArrivalTrain = {
      direction: '인천공항 방면',
      line: 'airport',
      arrivalAtMs: 1_000_000 + 600 * 1000,
    };

    render(<EditorialArrivalRow train={train} />);
    expect(screen.getByText('공항철도')).toBeTruthy();
  });

  it('should fallback to LINE label for unknown lines', () => {
    const train: ArrivalTrain = {
      direction: '방면',
      line: 'unknown',
      arrivalAtMs: 1_000_000 + 60 * 1000,
    };

    render(<EditorialArrivalRow train={train} />);
    expect(screen.getByText('LINE unknown')).toBeTruthy();
  });

  it('should have testID', () => {
    const train: ArrivalTrain = {
      direction: '봉화산 방면',
      line: '6',
      arrivalAtMs: 1_000_000 + 60 * 1000,
    };

    render(<EditorialArrivalRow train={train} />);
    expect(screen.getByTestId('editorial-arrival-row')).toBeTruthy();
  });
});
