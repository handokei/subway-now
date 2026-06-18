import { Linking } from 'react-native';
import { fireEvent } from '@testing-library/react-native';
import { PermissionChangeBanner } from '../PermissionChangeBanner';
import { renderWithTheme } from '../../../testUtils/renderWithTheme';

let openSettingsSpy: jest.SpyInstance;

beforeEach(() => {
  openSettingsSpy = jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined);
});

afterEach(() => {
  openSettingsSpy.mockRestore();
});

describe('PermissionChangeBanner', () => {
  it('change=none 일 때 null 렌더 (banner 미노출)', () => {
    const { queryByTestId } = renderWithTheme(
      <PermissionChangeBanner change="none" onAcknowledge={() => {}} />,
    );
    expect(queryByTestId('permission-change-banner')).toBeNull();
  });

  it('change=revoked 일 때 revoked 메시지가 노출된다', () => {
    const { getByTestId, getByText } = renderWithTheme(
      <PermissionChangeBanner change="revoked" onAcknowledge={() => {}} />,
    );
    expect(getByTestId('permission-change-banner')).toBeTruthy();
    expect(getByText('위치 권한이 회수되었어요')).toBeTruthy();
  });

  it('change=downgraded 일 때 downgraded 메시지가 노출된다', () => {
    const { getByText } = renderWithTheme(
      <PermissionChangeBanner change="downgraded" onAcknowledge={() => {}} />,
    );
    expect(getByText('백그라운드 위치 권한이 해제되었어요')).toBeTruthy();
  });

  it('액션 탭 시 onAcknowledge 호출 + Linking.openSettings 호출', () => {
    const onAcknowledge = jest.fn();
    const { getByTestId } = renderWithTheme(
      <PermissionChangeBanner change="revoked" onAcknowledge={onAcknowledge} />,
    );
    fireEvent.press(getByTestId('permission-change-open-settings'));
    expect(onAcknowledge).toHaveBeenCalledTimes(1);
    expect(openSettingsSpy).toHaveBeenCalledTimes(1);
  });
});
