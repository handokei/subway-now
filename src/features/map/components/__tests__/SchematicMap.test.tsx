import React from 'react';
import { Platform, StyleSheet } from 'react-native';
import * as RN from 'react-native';
import { act, fireEvent } from '@testing-library/react-native';
import { SchematicMap } from '../SchematicMap';
import { renderWithTheme } from '../../../../testUtils/renderWithTheme';
import { lightColors, darkColors } from '../../../../shared/theme';
import { LINE_COLORS } from '../../../../shared/constants/lineColors';
import layout from '../../../../data/schematicLayout.json';
import stationsData from '../../../../data/stations.json';
import type { Station } from '../../../../shared/types/station';

const stations = stationsData as Station[];
const nodes = Object.entries(layout.nodes) as [string, (typeof layout.nodes)[keyof typeof layout.nodes]][];
const transferNodes = nodes.filter(([, n]) => n.lines.length > 1);
const unsupportedNodes = nodes.filter(([, n]) => !n.supported);
const expectedSegments = layout.edges.reduce(
  (sum, e) => sum + 1 + ((e as { points?: number[][] }).points?.length ?? 0),
  0,
);

function setOS(os: 'ios' | 'android' | 'web') {
  (Platform as { OS: typeof Platform.OS }).OS = os;
}

const baseProps = {
  stations,
  nearestStation: null,
  selectedStation: null,
  focusStation: null,
  focusNonce: 0,
  onStationPress: jest.fn(),
};

const gangnam = stations.find((s) => s.name === '강남' && s.line === '2') as Station;

afterEach(() => {
  jest.restoreAllMocks();
  baseProps.onStationPress.mockClear();
  setOS('ios');
});

describe('SchematicMap 구조', () => {
  it('node 수·환승 원 수·선분 수·라벨 수가 layout과 일치한다', () => {
    const { queryAllByTestId } = renderWithTheme(<SchematicMap {...baseProps} />);
    const plain = queryAllByTestId(/^schematic-node-/);
    const transfer = queryAllByTestId(/^schematic-transfer-/);
    expect(plain.length + transfer.length).toBe(nodes.length);
    expect(transfer.length).toBe(transferNodes.length);
    expect(queryAllByTestId(/^schematic-edge-/).length).toBe(expectedSegments);
    expect(queryAllByTestId(/^schematic-label-/).length).toBe(nodes.length);
  });

  it('위치 없음(nearestStation null)이어도 렌더되고 가까운 역 강조 없음·버튼 비활성', () => {
    const { queryByTestId, getByTestId } = renderWithTheme(<SchematicMap {...baseProps} />);
    expect(queryByTestId('schematic-map')).not.toBeNull();
    expect(queryByTestId('schematic-nearest-highlight')).toBeNull();
    expect(getByTestId('schematic-go-nearest').props.accessibilityState?.disabled).toBe(true);
  });

  it('가까운 역이 있으면 강조 오버레이가 뜨고 버튼이 활성이다', () => {
    const { queryByTestId, getByTestId } = renderWithTheme(
      <SchematicMap {...baseProps} nearestStation={gangnam} />,
    );
    expect(queryByTestId('schematic-nearest-highlight')).not.toBeNull();
    expect(getByTestId('schematic-go-nearest').props.accessibilityState?.disabled).toBeFalsy();
  });

  it('선택 역이 있으면 선택 강조 오버레이가 뜬다', () => {
    const { queryByTestId, rerender } = renderWithTheme(<SchematicMap {...baseProps} />);
    expect(queryByTestId('schematic-selected-highlight')).toBeNull();
    rerender(<SchematicMap {...baseProps} selectedStation={gangnam} />);
    expect(queryByTestId('schematic-selected-highlight')).not.toBeNull();
  });

  it('검색 결과 선택(focusNonce 증가) 시 해당 node가 강조된다', () => {
    const { queryByTestId, rerender } = renderWithTheme(<SchematicMap {...baseProps} />);
    expect(queryByTestId('schematic-focus-highlight')).toBeNull();
    rerender(<SchematicMap {...baseProps} focusStation={gangnam} focusNonce={1} />);
    expect(queryByTestId('schematic-focus-highlight')).not.toBeNull();
  });
});

describe('SchematicMap 역 탭', () => {
  it('일반 node 탭 → onStationPress(해당 stationId의 Station)', () => {
    const [nodeId, node] = nodes.find(([, n]) => n.supported && n.stationIds.length === 1) as (typeof nodes)[number];
    const { getByTestId } = renderWithTheme(<SchematicMap {...baseProps} />);
    fireEvent.press(getByTestId(`schematic-node-${nodeId}`));
    expect(baseProps.onStationPress).toHaveBeenCalledTimes(1);
    expect((baseProps.onStationPress.mock.calls[0][0] as Station).id).toBe(node.stationIds[0]);
  });

  it('환승 node 탭 → stationIds 중 대표 역(노선 순서 첫 역)', () => {
    const [nodeId, node] = transferNodes.find(([, n]) => n.supported) as (typeof nodes)[number];
    const { getByTestId } = renderWithTheme(<SchematicMap {...baseProps} />);
    fireEvent.press(getByTestId(`schematic-transfer-${nodeId}`));
    const pressed = baseProps.onStationPress.mock.calls[0][0] as Station;
    expect(node.stationIds).toContain(pressed.id);
    const lineOrder = Object.keys(LINE_COLORS);
    const members = node.stationIds.map((id) => stations.find((s) => s.id === id) as Station);
    const first = [...members].sort((a, b) => lineOrder.indexOf(a.line) - lineOrder.indexOf(b.line))[0];
    expect(pressed.id).toBe(first.id);
  });

  it('supported:false node는 탭해도 onStationPress가 호출되지 않는다(회색)', () => {
    expect(unsupportedNodes.length).toBeGreaterThan(0);
    const [nodeId] = unsupportedNodes[0];
    const { getByTestId } = renderWithTheme(<SchematicMap {...baseProps} />);
    const el = getByTestId(`schematic-node-${nodeId}`);
    fireEvent.press(el);
    expect(baseProps.onStationPress).not.toHaveBeenCalled();
    expect(StyleSheet.flatten(el.props.style).backgroundColor).toBe(lightColors.subtle);
  });
});

describe('SchematicMap 확대/축소 (버튼 scale 단계)', () => {
  function scaleOf(getByTestId: (id: string) => { props: { style?: unknown } }) {
    const { transform } = StyleSheet.flatten(getByTestId('schematic-content').props.style) as {
      transform: { scale?: number }[];
    };
    return transform.find((t) => 'scale' in t)?.scale;
  }

  it('Android: 확대/축소 버튼이 0.5/1/2/3 단계를 이동하고 양 끝에서 멈춘다', () => {
    setOS('android');
    const { getByTestId } = renderWithTheme(<SchematicMap {...baseProps} />);
    expect(scaleOf(getByTestId)).toBe(1);
    fireEvent.press(getByTestId('schematic-zoom-in'));
    expect(scaleOf(getByTestId)).toBe(2);
    fireEvent.press(getByTestId('schematic-zoom-in'));
    expect(scaleOf(getByTestId)).toBe(3);
    fireEvent.press(getByTestId('schematic-zoom-in'));
    expect(scaleOf(getByTestId)).toBe(3);
    fireEvent.press(getByTestId('schematic-zoom-out'));
    fireEvent.press(getByTestId('schematic-zoom-out'));
    fireEvent.press(getByTestId('schematic-zoom-out'));
    expect(scaleOf(getByTestId)).toBe(0.5);
    fireEvent.press(getByTestId('schematic-zoom-out'));
    expect(scaleOf(getByTestId)).toBe(0.5);
  });

  it('iOS: 네이티브 pinch zoom 범위(min/max)를 ScrollView에 준다', () => {
    setOS('ios');
    const { getByTestId } = renderWithTheme(<SchematicMap {...baseProps} />);
    const { maximumZoomScale, minimumZoomScale } = getByTestId('schematic-scroll').props;
    expect(maximumZoomScale).toBeGreaterThan(1);
    expect(minimumZoomScale).toBeLessThan(1);
  });

  it('Android: 네이티브 zoom prop을 주지 않는다', () => {
    setOS('android');
    const { getByTestId } = renderWithTheme(<SchematicMap {...baseProps} />);
    expect(getByTestId('schematic-scroll').props.maximumZoomScale).toBeUndefined();
  });

  it('가까운 역으로 이동 버튼은 에러 없이 동작한다', () => {
    const { getByTestId } = renderWithTheme(<SchematicMap {...baseProps} nearestStation={gangnam} />);
    act(() => {
      fireEvent(getByTestId('schematic-scroll'), 'layout', { nativeEvent: { layout: { width: 400, height: 600 } } });
    });
    fireEvent.press(getByTestId('schematic-go-nearest'));
    expect(getByTestId('schematic-map')).toBeTruthy();
  });
});

describe('SchematicMap 테마', () => {
  function labelColor(getByTestId: (id: string) => { props: { style?: unknown } }) {
    const [nodeId] = nodes[0];
    return StyleSheet.flatten(getByTestId(`schematic-label-${nodeId}`).props.style).color;
  }

  it('라이트: 배경·라벨 색이 lightColors', () => {
    jest.spyOn(RN, 'useColorScheme').mockReturnValue('light');
    const { getByTestId } = renderWithTheme(<SchematicMap {...baseProps} />);
    expect(StyleSheet.flatten(getByTestId('schematic-map').props.style).backgroundColor).toBe(lightColors.bg);
    expect(labelColor(getByTestId)).toBe(lightColors.ink);
  });

  it('다크: 배경·라벨 색이 darkColors', () => {
    jest.spyOn(RN, 'useColorScheme').mockReturnValue('dark');
    const { getByTestId } = renderWithTheme(<SchematicMap {...baseProps} />);
    expect(StyleSheet.flatten(getByTestId('schematic-map').props.style).backgroundColor).toBe(darkColors.bg);
    expect(labelColor(getByTestId)).toBe(darkColors.ink);
  });

  it('선분 색은 LINE_COLORS', () => {
    const { getByTestId } = renderWithTheme(<SchematicMap {...baseProps} />);
    const { line } = layout.edges[0];
    expect(StyleSheet.flatten(getByTestId('schematic-edge-0').props.style).backgroundColor).toBe(
      LINE_COLORS[line as keyof typeof LINE_COLORS],
    );
  });
});
