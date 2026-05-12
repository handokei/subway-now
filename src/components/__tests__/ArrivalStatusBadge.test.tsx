import React from 'react';
import { screen } from '@testing-library/react-native';
import { ArrivalStatusBadge } from '../ArrivalStatusBadge';
import { renderWithTheme } from '../../testUtils/renderWithTheme';
import { ARRIVAL_CODE } from '../../constants/arrivalCodes';

describe('ArrivalStatusBadge', () => {
  it('표시할 배지가 없으면 null 반환', () => {
    const { toJSON } = renderWithTheme(<ArrivalStatusBadge />);
    expect(toJSON()).toBeNull();
  });

  it('isLastTrain → 막차 배지', () => {
    renderWithTheme(<ArrivalStatusBadge isLastTrain />);
    expect(screen.getByText('막차')).toBeTruthy();
  });

  it('arrivalCode=ARRIVED → 도착 배지', () => {
    renderWithTheme(<ArrivalStatusBadge arrivalCode={ARRIVAL_CODE.ARRIVED} />);
    expect(screen.getByText('도착')).toBeTruthy();
  });

  it('arrivalCode=ENTERING → 진입 배지', () => {
    renderWithTheme(<ArrivalStatusBadge arrivalCode={ARRIVAL_CODE.ENTERING} />);
    expect(screen.getByText('진입')).toBeTruthy();
  });

  it('arrivalCode=DEPARTED 등 그외 코드는 도착/진입 배지 미표시', () => {
    const { toJSON } = renderWithTheme(
      <ArrivalStatusBadge arrivalCode={ARRIVAL_CODE.DEPARTED} />,
    );
    expect(toJSON()).toBeNull();
  });

  it('trainType=express → 급행 배지', () => {
    renderWithTheme(<ArrivalStatusBadge trainType="express" />);
    expect(screen.getByText('급행')).toBeTruthy();
  });

  it('trainType=itx/rapid 라벨', () => {
    renderWithTheme(<ArrivalStatusBadge trainType="itx" />);
    expect(screen.getByText('ITX')).toBeTruthy();
  });

  it('trainType=rapid → 특급 배지', () => {
    renderWithTheme(<ArrivalStatusBadge trainType="rapid" />);
    expect(screen.getByText('특급')).toBeTruthy();
  });

  it('trainType=normal → 배지 미표시', () => {
    const { toJSON } = renderWithTheme(<ArrivalStatusBadge trainType="normal" />);
    expect(toJSON()).toBeNull();
  });

  it('막차 + 도착 + 급행 동시 표시', () => {
    renderWithTheme(
      <ArrivalStatusBadge isLastTrain arrivalCode={ARRIVAL_CODE.ARRIVED} trainType="express" />,
    );
    expect(screen.getByText('막차')).toBeTruthy();
    expect(screen.getByText('도착')).toBeTruthy();
    expect(screen.getByText('급행')).toBeTruthy();
  });
});
