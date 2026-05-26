import React from 'react';
import { screen } from '@testing-library/react-native';
import * as RN from 'react-native';
import i18next from 'i18next';
import { SourceBadge } from '../SourceBadge';
import { renderWithTheme } from '../../testUtils/renderWithTheme';

const mockUseColorScheme = jest.spyOn(RN, 'useColorScheme');

describe('SourceBadge', () => {
  beforeEach(() => {
    mockUseColorScheme.mockReturnValue('light');
  });

  afterEach(() => {
    mockUseColorScheme.mockReset();
  });

  it('position-train source → "열차 데이터" 라벨', () => {
    renderWithTheme(<SourceBadge source="position-train" />);
    expect(screen.getByText(i18next.t('source.positionTrain'))).toBeTruthy();
  });

  it('position source(fused) → "열차 데이터" 라벨로 묶임', () => {
    renderWithTheme(<SourceBadge source="position" />);
    expect(screen.getByText(i18next.t('source.positionTrain'))).toBeTruthy();
  });

  it('arrival source(fused) → "열차 데이터" 라벨로 묶임', () => {
    renderWithTheme(<SourceBadge source="arrival" />);
    expect(screen.getByText(i18next.t('source.positionTrain'))).toBeTruthy();
  });

  it('route-progress source → "경로 추정" 라벨', () => {
    renderWithTheme(<SourceBadge source="route-progress" />);
    expect(screen.getByText(i18next.t('source.routeProgress'))).toBeTruthy();
  });

  it('gps source → "GPS 추정" 라벨', () => {
    renderWithTheme(<SourceBadge source="gps" />);
    expect(screen.getByText(i18next.t('source.gpsOnly'))).toBeTruthy();
  });

  it('locationUncertain=true → source=position-train이어도 "위치 확인 중"', () => {
    renderWithTheme(<SourceBadge source="position-train" locationUncertain={true} />);
    expect(screen.getByText(i18next.t('source.uncertain'))).toBeTruthy();
  });

  it('locationUncertain=true → source=gps여도 "위치 확인 중"', () => {
    renderWithTheme(<SourceBadge source="gps" locationUncertain={true} />);
    expect(screen.getByText(i18next.t('source.uncertain'))).toBeTruthy();
  });

  it('locationUncertain=true → source=route-progress여도 "위치 확인 중"', () => {
    renderWithTheme(<SourceBadge source="route-progress" locationUncertain={true} />);
    expect(screen.getByText(i18next.t('source.uncertain'))).toBeTruthy();
  });

  it('testID를 전달한다', () => {
    renderWithTheme(<SourceBadge source="gps" testID="my-badge" />);
    expect(screen.getByTestId('my-badge')).toBeTruthy();
  });

  it('다크모드에서도 정상 렌더', () => {
    mockUseColorScheme.mockReturnValue('dark');
    renderWithTheme(<SourceBadge source="gps" />);
    expect(screen.getByText(i18next.t('source.gpsOnly'))).toBeTruthy();
  });
});
