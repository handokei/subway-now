import React from 'react';
import { fireEvent } from '@testing-library/react-native';
import { MapModeSwitch } from '../MapModeSwitch';
import { renderWithTheme } from '../../../../testUtils/renderWithTheme';

describe('MapModeSwitch', () => {
  it('지도|노선도 두 칸, 탭 → onChange(mode)', () => {
    const onChange = jest.fn();
    const { getByTestId } = renderWithTheme(<MapModeSwitch mode="map" onChange={onChange} />);
    fireEvent.press(getByTestId('map-mode-schematic'));
    expect(onChange).toHaveBeenCalledWith('schematic');
    fireEvent.press(getByTestId('map-mode-map'));
    expect(onChange).toHaveBeenCalledWith('map');
  });

  it('선택된 칸은 accessibilityState.selected', () => {
    const { getByTestId } = renderWithTheme(<MapModeSwitch mode="schematic" onChange={jest.fn()} />);
    expect(getByTestId('map-mode-schematic').props.accessibilityState.selected).toBe(true);
    expect(getByTestId('map-mode-map').props.accessibilityState.selected).toBe(false);
  });
});
