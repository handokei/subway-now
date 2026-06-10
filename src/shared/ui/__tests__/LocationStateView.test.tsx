import React from 'react';
import { screen, fireEvent } from '@testing-library/react-native';
import * as RN from 'react-native';
import { LocationStateView } from '../LocationStateView';
import { renderWithTheme } from '../../../testUtils/renderWithTheme';
import { openAppSettings } from '../../utils/openAppSettings';

jest.mock('../../utils/openAppSettings', () => ({
  openAppSettings: jest.fn(),
}));

const mockUseColorScheme = jest.spyOn(RN, 'useColorScheme');

describe('LocationStateView', () => {
  const onRetry = jest.fn();

  beforeEach(() => {
    mockUseColorScheme.mockReturnValue('light');
    onRetry.mockReset();
    (openAppSettings as jest.Mock).mockReset();
  });

  afterEach(() => {
    mockUseColorScheme.mockReset();
  });

  it('모든 상태가 비활성일 때 null을 반환한다', () => {
    const { toJSON } = renderWithTheme(
      <LocationStateView permissionDenied={false} loading={false} error={null} onRetry={onRetry} />,
    );
    expect(toJSON()).toBeNull();
  });

  describe('permissionDenied 상태', () => {
    beforeEach(() => {
      renderWithTheme(
        <LocationStateView permissionDenied={true} loading={false} error={null} onRetry={onRetry} />,
      );
    });

    it('권한 거부 메시지를 표시한다', () => {
      expect(screen.getByText('위치 권한이 필요합니다.')).toBeTruthy();
    });

    it('권한 요청 버튼을 표시한다', () => {
      expect(screen.getByText('권한 요청')).toBeTruthy();
    });

    it('권한 요청 버튼 클릭 시 onRetry를 호출한다', () => {
      fireEvent.press(screen.getByTestId('location-retry-button'));
      expect(onRetry).toHaveBeenCalledTimes(1);
    });

    it('"설정 열기" 버튼을 표시한다', () => {
      expect(screen.getByText('설정 열기')).toBeTruthy();
    });

    it('"설정 열기" 버튼 클릭 시 openAppSettings를 호출한다', () => {
      fireEvent.press(screen.getByTestId('location-open-settings-button'));
      expect(openAppSettings).toHaveBeenCalledTimes(1);
    });
  });

  describe('loading 상태', () => {
    it('로딩 메시지를 표시한다', () => {
      renderWithTheme(
        <LocationStateView permissionDenied={false} loading={true} error={null} onRetry={onRetry} />,
      );
      expect(screen.getByText('위치 확인 중...')).toBeTruthy();
    });

    it('로딩 상태에서는 버튼을 표시하지 않는다', () => {
      renderWithTheme(
        <LocationStateView permissionDenied={false} loading={true} error={null} onRetry={onRetry} />,
      );
      expect(screen.queryByTestId('location-retry-button')).toBeNull();
    });
  });

  describe('error 상태', () => {
    it('에러 메시지를 표시한다', () => {
      renderWithTheme(
        <LocationStateView permissionDenied={false} loading={false} error="위치를 가져올 수 없습니다." onRetry={onRetry} />,
      );
      expect(screen.getByText('위치를 가져올 수 없습니다.')).toBeTruthy();
    });

    it('다시 시도 버튼을 표시한다', () => {
      renderWithTheme(
        <LocationStateView permissionDenied={false} loading={false} error="에러 발생" onRetry={onRetry} />,
      );
      expect(screen.getByText('다시 시도')).toBeTruthy();
    });

    it('다시 시도 버튼 클릭 시 onRetry를 호출한다', () => {
      renderWithTheme(
        <LocationStateView permissionDenied={false} loading={false} error="에러 발생" onRetry={onRetry} />,
      );
      fireEvent.press(screen.getByTestId('location-retry-button'));
      expect(onRetry).toHaveBeenCalledTimes(1);
    });
  });

  describe('우선순위: permissionDenied가 loading/error보다 우선한다', () => {
    it('permissionDenied와 loading이 모두 true일 때 권한 거부 UI를 표시한다', () => {
      renderWithTheme(
        <LocationStateView permissionDenied={true} loading={true} error={null} onRetry={onRetry} />,
      );
      expect(screen.getByText('위치 권한이 필요합니다.')).toBeTruthy();
      expect(screen.queryByText('위치 확인 중...')).toBeNull();
    });

    it('permissionDenied와 error가 모두 있을 때 권한 거부 UI를 표시한다', () => {
      renderWithTheme(
        <LocationStateView permissionDenied={true} loading={false} error="에러" onRetry={onRetry} />,
      );
      expect(screen.getByText('위치 권한이 필요합니다.')).toBeTruthy();
      expect(screen.queryByText('에러')).toBeNull();
    });

    it('loading과 error가 모두 있을 때 loading UI를 표시한다', () => {
      renderWithTheme(
        <LocationStateView permissionDenied={false} loading={true} error="에러" onRetry={onRetry} />,
      );
      expect(screen.getByText('위치 확인 중...')).toBeTruthy();
      expect(screen.queryByText('에러')).toBeNull();
    });
  });

  describe('다크 모드', () => {
    it('다크 모드에서도 권한 거부 메시지를 표시한다', () => {
      mockUseColorScheme.mockReturnValue('dark');
      renderWithTheme(
        <LocationStateView permissionDenied={true} loading={false} error={null} onRetry={onRetry} />,
      );
      expect(screen.getByText('위치 권한이 필요합니다.')).toBeTruthy();
    });
  });
});
