import React from 'react';
import { screen } from '@testing-library/react-native';
import * as RN from 'react-native';
import i18next from 'i18next';
import { SourceBadge } from '../SourceBadge';
import { renderWithTheme } from '../../../../testUtils/renderWithTheme';
import type { FusionSource } from '../../../nearest-station/utils/pickFusedStation';

const mockUseColorScheme = jest.spyOn(RN, 'useColorScheme');

describe('SourceBadge', () => {
  beforeEach(() => {
    mockUseColorScheme.mockReturnValue('light');
  });

  afterEach(() => {
    mockUseColorScheme.mockReset();
  });

  // 자백 대상이 아닌 source는 노이즈 회피 위해 렌더 안 함 (#327 UX 정책).
  it.each<FusionSource>(['position-train', 'position', 'arrival', 'route-progress'])(
    '%s source → 정상 신뢰 케이스라 라벨 표시 안 함 (null 반환)',
    (source) => {
      renderWithTheme(<SourceBadge source={source} testID="badge" />);
      expect(screen.queryByTestId('badge')).toBeNull();
    },
  );

  it('gps source → "GPS 추정" 라벨 (자백 대상)', () => {
    renderWithTheme(<SourceBadge source="gps" />);
    expect(screen.getByText(i18next.t('source.gpsOnly'))).toBeTruthy();
  });

  // uncertain은 source와 무관하게 항상 자백 대상.
  it.each<FusionSource>(['position-train', 'gps', 'route-progress'])(
    'locationUncertain=true → %s여도 "위치 확인 중" 라벨',
    (source) => {
      renderWithTheme(<SourceBadge source={source} locationUncertain={true} />);
      expect(screen.getByText(i18next.t('source.uncertain'))).toBeTruthy();
    },
  );

  it('testID를 전달한다 (gps 자백 시)', () => {
    renderWithTheme(<SourceBadge source="gps" testID="my-badge" />);
    expect(screen.getByTestId('my-badge')).toBeTruthy();
  });

  it('다크모드에서도 정상 렌더 (gps)', () => {
    mockUseColorScheme.mockReturnValue('dark');
    renderWithTheme(<SourceBadge source="gps" />);
    expect(screen.getByText(i18next.t('source.gpsOnly'))).toBeTruthy();
  });
});
