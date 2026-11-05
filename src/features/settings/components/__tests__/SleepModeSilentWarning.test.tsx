import React from 'react';
import { screen } from '@testing-library/react-native';
import { renderWithTheme } from '../../../../testUtils/renderWithTheme';
import { SleepModeSilentWarning } from '../SleepModeSilentWarning';

// #2807 — Critical Alerts 애플 거부로 무음 모드에서는 취침모드 알람이 울리지 않을 수 있음을
// 안내하는 컴포넌트. 취침모드가 켜진 컨텍스트(visible=true)에서만 노출되어야 한다.
describe('SleepModeSilentWarning', () => {
  it('취침모드 컨텍스트(visible=true)에서 안내 문구를 노출한다', () => {
    renderWithTheme(<SleepModeSilentWarning visible />);

    expect(screen.getByText('취침모드 알람은 휴대폰 소리를 켜두셔야 울립니다. 무음 모드에서는 알림이 오지 않을 수 있어요.')).toBeTruthy();
  });

  it('일반모드(visible=false)에서는 안내 문구를 노출하지 않는다', () => {
    renderWithTheme(<SleepModeSilentWarning visible={false} />);

    expect(screen.queryByText('취침모드 알람은 휴대폰 소리를 켜두셔야 울립니다. 무음 모드에서는 알림이 오지 않을 수 있어요.')).toBeNull();
  });
});
