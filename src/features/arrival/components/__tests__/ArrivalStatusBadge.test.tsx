import React from 'react';
import { StyleSheet } from 'react-native';
import { screen } from '@testing-library/react-native';
import { ArrivalStatusBadge } from '../ArrivalStatusBadge';
import { renderWithTheme } from '../../../../testUtils/renderWithTheme';
import { ARRIVAL_CODE } from '../../../../shared/constants/arrivalCodes';

describe('ArrivalStatusBadge', () => {
  it('표시할 배지가 없으면 null 반환', () => {
    const { toJSON } = renderWithTheme(<ArrivalStatusBadge />);
    expect(toJSON()).toBeNull();
  });

  it('isLastTrain → 막차 배지', () => {
    renderWithTheme(<ArrivalStatusBadge isLastTrain />);
    expect(screen.getByText('막차')).toBeTruthy();
  });

  it('isLastTrain + 컨텍스트 → "막차 HH:mm" 시각 동봉', () => {
    renderWithTheme(
      <ArrivalStatusBadge isLastTrain stationName="소요산" line="1" direction="down" />,
    );
    // 1호선 소요산 down weekday/saturday/sunday 모두 "23:47"로 끝나는 데이터.
    // (요일별 분기 검증은 lastTrainTime 단위 테스트에서 별도 수행)
    expect(screen.getByText(/^막차 \d{2}:\d{2}$/)).toBeTruthy();
  });

  it('isLastTrain + 컨텍스트지만 timetable 없는 노선 → 기존 "막차" fallback', () => {
    renderWithTheme(
      <ArrivalStatusBadge isLastTrain stationName="서울역" line="airport" direction="up" />,
    );
    expect(screen.getByText('막차')).toBeTruthy();
  });

  it('isLastTrain + stationName만 제공(불완전 컨텍스트) → "막차" fallback', () => {
    renderWithTheme(<ArrivalStatusBadge isLastTrain stationName="소요산" />);
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

  it('급행 + 막차 동시 시 급행이 가장 먼저 표시 (안전성 직결 정보 우선)', () => {
    renderWithTheme(<ArrivalStatusBadge isLastTrain trainType="express" />);
    const row = screen.getByTestId('arrival-status-badge');
    const labels = row.children
      .map((c: unknown) => {
        if (typeof c !== 'object' || c === null) return undefined;
        const node = c as { props?: { testID?: string } };
        return node.props?.testID;
      })
      .filter((id: string | undefined): id is string => typeof id === 'string');
    expect(labels[0]).toBe('arrival-status-badge-급행');
    expect(labels[1]).toBe('arrival-status-badge-막차');
  });

  describe('variant 스타일', () => {
    it('급행 배지는 filled (배경색 채움)', () => {
      renderWithTheme(<ArrivalStatusBadge trainType="express" />);
      const badge = screen.getByTestId('arrival-status-badge-급행');
      const style = StyleSheet.flatten(badge.props.style);
      expect(style.backgroundColor).toBeDefined();
      expect(style.backgroundColor).toBe(style.borderColor);
    });

    it('ITX/특급도 filled', () => {
      renderWithTheme(<ArrivalStatusBadge trainType="itx" />);
      const itx = screen.getByTestId('arrival-status-badge-ITX');
      const itxStyle = Array.isArray(itx.props.style)
        ? Object.assign({}, ...itx.props.style)
        : itx.props.style;
      expect(itxStyle.backgroundColor).toBeDefined();
    });

    it('막차 배지는 outline (배경색 없음)', () => {
      renderWithTheme(<ArrivalStatusBadge isLastTrain />);
      const badge = screen.getByTestId('arrival-status-badge-막차');
      const style = StyleSheet.flatten(badge.props.style);
      expect(style.backgroundColor).toBeUndefined();
      expect(style.borderColor).toBeDefined();
    });

    it('도착/진입 배지는 outline', () => {
      renderWithTheme(<ArrivalStatusBadge arrivalCode={ARRIVAL_CODE.ENTERING} />);
      const badge = screen.getByTestId('arrival-status-badge-진입');
      const style = StyleSheet.flatten(badge.props.style);
      expect(style.backgroundColor).toBeUndefined();
    });
  });
});
