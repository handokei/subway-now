import React from 'react';
import { StyleSheet } from 'react-native';
import * as RN from 'react-native';
import { ShadowCaster } from '../ShadowCaster';
import { lightColors, darkColors } from '../../theme';
import { renderWithTheme } from '../../../testUtils/renderWithTheme';

const mockUseColorScheme = jest.spyOn(RN, 'useColorScheme');

function casterStyle(ui: React.ReactElement) {
  const { toJSON } = renderWithTheme(ui);
  const tree = toJSON() as unknown as { props: { style: unknown; pointerEvents?: string } };
  return { flat: StyleSheet.flatten(tree.props.style as never) as Record<string, unknown>, tree };
}

describe('ShadowCaster', () => {
  beforeEach(() => {
    mockUseColorScheme.mockReturnValue('light');
  });
  afterEach(() => {
    mockUseColorScheme.mockReset();
  });

  it('불투명(alpha=1) 배경 + legacy shadow — shadowPath 경로 성립', () => {
    const { flat } = casterStyle(<ShadowCaster kind="card" r={26} />);
    expect(flat.backgroundColor).toBe(lightColors.shadowCaster);
    expect(lightColors.shadowCaster).toMatch(/^#[0-9a-f]{6}$/i);
    expect(darkColors.shadowCaster).toMatch(/^#[0-9a-f]{6}$/i);
    expect(flat.shadowRadius).toBe(15);
    expect(flat.shadowOpacity).toBe(0.14);
  });

  it('터치 무영향: pointerEvents none', () => {
    const { tree } = casterStyle(<ShadowCaster kind="card" r={26} />);
    expect(tree.props.pointerEvents).toBe('none');
  });

  it('기본 2px inset, r에서 inset을 뺀 모서리', () => {
    const { flat } = casterStyle(<ShadowCaster kind="card" r={26} />);
    expect(flat).toMatchObject({ top: 2, left: 2, right: 2, bottom: 2, borderRadius: 24 });
  });

  it('inset/r 커스텀, r<inset이면 모서리 0', () => {
    expect(casterStyle(<ShadowCaster kind="card" r={26} inset={4} />).flat).toMatchObject({ top: 4, borderRadius: 22 });
    expect(casterStyle(<ShadowCaster kind="card" r={1} />).flat.borderRadius).toBe(0);
  });

  it('다크: 다크 캐스터 색과 다크 그림자', () => {
    mockUseColorScheme.mockReturnValue('dark');
    const { flat } = casterStyle(<ShadowCaster kind="card" r={26} />);
    expect(flat.backgroundColor).toBe(darkColors.shadowCaster);
    expect(flat.shadowOpacity).toBe(0.5);
  });
});
