import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme, spacing, type ThemeColors } from '../../../shared/theme';
import { LINE_COLORS } from '../../../shared/constants/lineColors';
import { MIN_TOUCH_TARGET } from '../../../shared/constants/touchTarget';
import {
  SCHEMATIC_DEFAULT_ZOOM_INDEX,
  SCHEMATIC_FOCUS_HIGHLIGHT_MS,
  SCHEMATIC_HIGHLIGHT_NEAREST_SIZE,
  SCHEMATIC_HIGHLIGHT_SELECTED_SIZE,
  SCHEMATIC_LABEL_FONT_SIZE,
  SCHEMATIC_LABEL_HEIGHT,
  SCHEMATIC_LABEL_WIDTH,
  SCHEMATIC_LINE_THICKNESS,
  SCHEMATIC_NODE_BORDER,
  SCHEMATIC_NODE_HIT_SLOP,
  SCHEMATIC_NODE_SIZE,
  SCHEMATIC_TRANSFER_NODE_SIZE,
  SCHEMATIC_ZOOM_STEPS,
} from '../../../shared/constants/schematicMap';
import type { LineNumber, Station } from '../../../shared/types/station';
import layoutData from '../../../data/schematicLayout.json';
import { pickNodeStation } from '../utils/pickNodeStation';

type LabelAnchor = 'start' | 'middle' | 'end';

interface SchematicNode {
  readonly x: number;
  readonly y: number;
  readonly name: string;
  readonly lines: readonly LineNumber[];
  readonly stationIds: readonly string[];
  readonly supported: boolean;
  readonly label: { readonly dx: number; readonly dy: number; readonly anchor: LabelAnchor };
}

interface SchematicEdge {
  readonly line: LineNumber;
  readonly from: string;
  readonly to: string;
  readonly points?: readonly (readonly [number, number])[];
}

interface Segment {
  readonly key: string;
  readonly line: LineNumber;
  readonly left: number;
  readonly top: number;
  readonly length: number;
  readonly angle: number;
}

const NODES = layoutData.nodes as unknown as Record<string, SchematicNode>;
const EDGES = layoutData.edges as unknown as readonly SchematicEdge[];
const { w: CONTENT_WIDTH, h: CONTENT_HEIGHT } = layoutData.bounds;
const NODE_ENTRIES = Object.entries(NODES);

/** stationId → 그 역이 속한 node (탭·강조·스크롤 공용 역방향 인덱스). */
const STATION_NODE = new Map<string, string>(
  NODE_ENTRIES.flatMap(([nodeId, { stationIds }]) => stationIds.map((id) => [id, nodeId] as const)),
);

const LABEL_LEFT_OFFSET: Record<LabelAnchor, number> = { start: 0, middle: -SCHEMATIC_LABEL_WIDTH / 2, end: -SCHEMATIC_LABEL_WIDTH };
const LABEL_TEXT_ALIGN: Record<LabelAnchor, 'left' | 'center' | 'right'> = { start: 'left', middle: 'center', end: 'right' };

/** edge(+꺾임 points) → 선분 목록. 선분 = 길이·각도를 계산한 회전 View 하나. */
const SEGMENTS: readonly Segment[] = (() => {
  const segments: Segment[] = [];
  for (const edge of EDGES) {
    const { from, to, points = [], line } = edge;
    const { x: x1, y: y1 } = NODES[from];
    const { x: x2, y: y2 } = NODES[to];
    const path: readonly (readonly [number, number])[] = [[x1, y1], ...points, [x2, y2]];
    for (let i = 0; i < path.length - 1; i += 1) {
      const [ax, ay] = path[i];
      const [bx, by] = path[i + 1];
      const length = Math.hypot(bx - ax, by - ay);
      segments.push({
        key: `schematic-edge-${segments.length}`,
        line,
        left: (ax + bx) / 2 - length / 2,
        top: (ay + by) / 2 - SCHEMATIC_LINE_THICKNESS / 2,
        length,
        angle: (Math.atan2(by - ay, bx - ax) * 180) / Math.PI,
      });
    }
  }
  return segments;
})();

interface StaticLayerProps {
  readonly colors: ThemeColors;
  readonly onNodePress: (nodeId: string) => void;
}

/** 정적 레이아웃(선분·역·라벨) — 테마가 바뀔 때만 다시 그린다. 강조는 별도 오버레이. */
const StaticLayer = memo(function StaticLayer({ colors, onNodePress }: StaticLayerProps) {
  return (
    <>
      {SEGMENTS.map(({ key, line, left, top, length, angle }) => (
        <View
          key={key}
          pointerEvents="none"
          testID={key}
          style={[
            styles.segment,
            { left, top, width: length, backgroundColor: LINE_COLORS[line], transform: [{ rotate: `${angle}deg` }] },
          ]}
        />
      ))}
      {NODE_ENTRIES.map(([nodeId, node]) => {
        const { x, y, lines, supported } = node;
        const isTransfer = lines.length > 1;
        const size = isTransfer ? SCHEMATIC_TRANSFER_NODE_SIZE : SCHEMATIC_NODE_SIZE;
        const [firstLine] = lines;
        const borderColor = !supported ? colors.subtle : isTransfer ? colors.ink : LINE_COLORS[firstLine];
        const circle = [
          styles.node,
          {
            left: x - size / 2,
            top: y - size / 2,
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: supported ? colors.bg : colors.subtle,
            borderColor,
          },
        ];
        const testID = `${isTransfer ? 'schematic-transfer-' : 'schematic-node-'}${nodeId}`;
        return supported ? (
          <Pressable
            key={nodeId}
            testID={testID}
            style={circle}
            hitSlop={SCHEMATIC_NODE_HIT_SLOP}
            accessibilityRole="button"
            accessibilityLabel={node.name}
            onPress={() => onNodePress(nodeId)}
          />
        ) : (
          <View key={nodeId} testID={testID} style={circle} pointerEvents="none" />
        );
      })}
      {NODE_ENTRIES.map(([nodeId, { x, y, name, label, supported }]) => {
        const { dx, dy, anchor } = label;
        return (
          <Text
            key={nodeId}
            testID={`schematic-label-${nodeId}`}
            pointerEvents="none"
            numberOfLines={1}
            style={[
              styles.label,
              {
                left: x + dx + LABEL_LEFT_OFFSET[anchor],
                top: y + dy - SCHEMATIC_LABEL_HEIGHT / 2,
                textAlign: LABEL_TEXT_ALIGN[anchor],
                color: supported ? colors.ink : colors.subtle,
              },
            ]}
          >
            {name}
          </Text>
        );
      })}
    </>
  );
});

interface RingProps {
  readonly nodeId: string;
  readonly size: number;
  readonly color: string;
  readonly testID: string;
}

function HighlightRing({ nodeId, size, color, testID }: RingProps) {
  const { x, y } = NODES[nodeId];
  return (
    <View
      pointerEvents="none"
      testID={testID}
      style={[styles.ring, { left: x - size / 2, top: y - size / 2, width: size, height: size, borderRadius: size / 2, borderColor: color }]}
    />
  );
}

function nodeIdOf(station: Station | null): string | undefined {
  return station ? STATION_NODE.get(station.id) : undefined;
}

interface Props {
  readonly stations: readonly Station[];
  readonly nearestStation: Station | null;
  readonly selectedStation: Station | null;
  readonly focusStation: Station | null;
  readonly focusNonce: number;
  /** 버튼 하단 여백(탭바·선택 카드 위로 띄움) */
  readonly bottomOffset: number;
  readonly onStationPress: (station: Station) => void;
}

/**
 * #3371 — 1~9호선 노선도(자체 배치 데이터 schematicLayout.json). 신규 네이티브 의존성 없이 View로 그린다.
 * 확대/이동: 중첩 ScrollView + iOS 네이티브 pinch(min/max zoom) + 전 플랫폼 버튼 scale 단계.
 */
export function SchematicMap({ stations, nearestStation, selectedStation, focusStation, focusNonce, bottomOffset, onStationPress }: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const [zoomIndex, setZoomIndex] = useState(SCHEMATIC_DEFAULT_ZOOM_INDEX);
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);
  const verticalRef = useRef<ScrollView>(null);
  const horizontalRef = useRef<ScrollView>(null);
  const viewport = useRef({ width: 0, height: 0 });
  const scale = SCHEMATIC_ZOOM_STEPS[zoomIndex];

  // StaticLayer(memo)가 매 렌더 재그려지지 않도록 안정 콜백 + 최신 클로저를 ref로 전달.
  const latestPress = (nodeId: string) => {
    const station = pickNodeStation(NODES[nodeId].stationIds, stations);
    if (station) onStationPress(station);
  };
  const pressRef = useRef(latestPress);
  pressRef.current = latestPress;
  const handleNodePress = useCallback((nodeId: string) => pressRef.current(nodeId), []);

  const scrollToNode = useCallback(
    (nodeId: string) => {
      const { x, y } = NODES[nodeId];
      const { width, height } = viewport.current;
      horizontalRef.current?.scrollTo({ x: Math.max(0, x * scale - width / 2), animated: true });
      verticalRef.current?.scrollTo({ y: Math.max(0, y * scale - height / 2), animated: true });
    },
    [scale],
  );

  const nearestNodeId = nodeIdOf(nearestStation);
  const selectedNodeId = nodeIdOf(selectedStation);
  const focusNodeId = nodeIdOf(focusStation);

  // 검색 결과 선택(focusNonce 증가) → 해당 node로 스크롤 + 잠시 강조.
  useEffect(() => {
    if (!focusNonce || !focusNodeId) return undefined;
    scrollToNode(focusNodeId);
    setFocusedNodeId(focusNodeId);
    const timer = setTimeout(() => setFocusedNodeId(null), SCHEMATIC_FOCUS_HIGHLIGHT_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- nonce 증가에만 반응(scale 변경으로 재스크롤 금지)
  }, [focusNonce]);

  const zoomIn = useCallback(() => setZoomIndex((i) => Math.min(i + 1, SCHEMATIC_ZOOM_STEPS.length - 1)), []);
  const zoomOut = useCallback(() => setZoomIndex((i) => Math.max(i - 1, 0)), []);
  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    viewport.current = { width, height };
  }, []);

  const nativeZoomProps = useMemo(
    () =>
      Platform.OS === 'ios'
        ? { maximumZoomScale: SCHEMATIC_ZOOM_STEPS[SCHEMATIC_ZOOM_STEPS.length - 1], minimumZoomScale: SCHEMATIC_ZOOM_STEPS[0], bouncesZoom: true }
        : {},
    [],
  );

  const buttons = [
    { key: 'zoom-in', glyph: '+', label: t('map.schematic.zoomIn'), onPress: zoomIn, disabled: false },
    { key: 'zoom-out', glyph: '−', label: t('map.schematic.zoomOut'), onPress: zoomOut, disabled: false },
    { key: 'go-nearest', glyph: '◎', label: t('map.schematic.goNearest'), onPress: nearestNodeId ? () => scrollToNode(nearestNodeId) : undefined, disabled: !nearestNodeId },
  ];

  return (
    <View style={[styles.container, { backgroundColor: colors.bg }]} testID="schematic-map">
      <ScrollView
        ref={verticalRef}
        testID="schematic-scroll"
        onLayout={onLayout}
        showsVerticalScrollIndicator={false}
        {...nativeZoomProps}
      >
        <ScrollView ref={horizontalRef} horizontal nestedScrollEnabled showsHorizontalScrollIndicator={false}>
          <View style={{ width: CONTENT_WIDTH * scale, height: CONTENT_HEIGHT * scale }}>
            <View
              testID="schematic-content"
              style={[styles.content, { width: CONTENT_WIDTH, height: CONTENT_HEIGHT, transform: [{ scale }] }]}
            >
              <StaticLayer colors={colors} onNodePress={handleNodePress} />
              {nearestNodeId && (
                <HighlightRing nodeId={nearestNodeId} size={SCHEMATIC_HIGHLIGHT_NEAREST_SIZE} color={colors.accent} testID="schematic-nearest-highlight" />
              )}
              {selectedNodeId && (
                <HighlightRing nodeId={selectedNodeId} size={SCHEMATIC_HIGHLIGHT_SELECTED_SIZE} color={colors.ink} testID="schematic-selected-highlight" />
              )}
              {focusedNodeId && (
                <HighlightRing nodeId={focusedNodeId} size={SCHEMATIC_HIGHLIGHT_SELECTED_SIZE} color={colors.accent} testID="schematic-focus-highlight" />
              )}
            </View>
          </View>
        </ScrollView>
      </ScrollView>
      <View style={[styles.buttons, { bottom: bottomOffset }]} pointerEvents="box-none">
        {buttons.map(({ key, glyph, label, onPress, disabled }) => (
          <Pressable
            key={key}
            testID={`schematic-${key}`}
            onPress={onPress}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityState={{ disabled }}
            style={[styles.button, { backgroundColor: colors.glassStrong, borderColor: colors.glassBorder, opacity: disabled ? 0.4 : 1 }]}
          >
            <Text style={[styles.buttonGlyph, { color: colors.ink }]}>{glyph}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { transformOrigin: 'top left' },
  segment: { position: 'absolute', height: SCHEMATIC_LINE_THICKNESS },
  node: { position: 'absolute', borderWidth: SCHEMATIC_NODE_BORDER },
  label: {
    position: 'absolute',
    width: SCHEMATIC_LABEL_WIDTH,
    height: SCHEMATIC_LABEL_HEIGHT,
    fontSize: SCHEMATIC_LABEL_FONT_SIZE,
    lineHeight: SCHEMATIC_LABEL_HEIGHT,
  },
  ring: { position: 'absolute', borderWidth: 3 },
  buttons: { position: 'absolute', right: spacing.lg, gap: spacing.sm },
  button: {
    width: MIN_TOUCH_TARGET,
    height: MIN_TOUCH_TARGET,
    borderRadius: MIN_TOUCH_TARGET / 2,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonGlyph: { fontSize: 20, lineHeight: 24 },
});
