/**
 * TripDetailModal (#1956, S-m3-1 P0 / Epic #1503).
 *
 * Operation Dashboard 4 metric 차트를 클릭하면 진입하는 metric drill-down 상세 화면.
 * 4 영역을 한 modal에서 표시:
 *
 *   1) Token       — 클릭된 trip의 corrId (또는 'unknown' 버킷)
 *   2) Lifecycle   — 첫 entry ts / 마지막 entry ts / duration / kind별 카운트
 *   3) Raw signal  — RawSignalEntry 최신순 최대 TRIP_DETAIL_RAW_SIGNAL_LIMIT(30)건
 *   4) Deep link   — Sentry/R2 외부 검사 URL (env 미설정 시 행 숨김)
 *
 * 데이터 흐름:
 *   onMetricClick(metric, value, ts)  → DebugModal owner state(selectedTripToken)
 *   ↓
 *   <TripDetailModal tripToken=... onClose=... />
 *   ↓
 *   useTripDetail(tripToken) — rawSignalBuffer subscribe + buildTripDetail
 *   ↓
 *   buildTripDetail(entries, tripToken) → TripDetail (4 영역 derived data)
 *
 * MetricDrillDownView(corrId 그룹 목록)와 별 채널 — drill-down 흐름은:
 *   metric 클릭 → MetricDrillDownView(전체 corrId 목록) → 행 클릭 → TripDetailModal(단일 trip 상세)
 * 본 PR은 4 metric 차트 클릭 → 즉시 TripDetailModal 진입(가장 최근 trip 또는 null fallback).
 *
 * Deep link 정책:
 *   - EXPO_PUBLIC_SENTRY_DSN 미설정이면 Sentry 행 자체 미렌더 (사용자 혼란 방지)
 *   - R2는 deep link URL 자체가 사후 결정(backend admin) — 본 PR은 외부 검사 진입점만 표시
 */
import { useCallback } from 'react';
import {
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useTheme, spacing, radius, typography } from '../../../shared/theme';
import { formatClockTimeWithSeconds } from '../../../shared/utils/formatTime';
import { useTripDetail } from '../hooks/useTripDetail';
import type { TripDetail } from '../utils/buildTripDetail';
import type { RawSignalEntry } from '../../observability/utils/rawSignalBuffer';

/** Sentry deep link base URL — DSN 미설정 시 null. */
const SENTRY_DSN_ENV_VAR = 'EXPO_PUBLIC_SENTRY_DSN';

/** kind 라벨 — kindCounts row 표시용. */
const KIND_LABELS = ['cycle', 'enter', 'exit'] as const;

/** trip token이 null 또는 매칭 0건일 때의 fallback 메시지. */
const NO_TRIP_LABEL = '(no trip)';

export interface TripDetailModalProps {
  /** modal 표시 여부. tripToken=null이어도 visible=true면 fallback UI 노출. */
  visible: boolean;
  /** 표시할 trip의 corrId 또는 'unknown' 버킷. null이면 fallback UI. */
  tripToken: string | null;
  /** 닫기 — backdrop / 닫기 버튼 / OS back. */
  onClose: () => void;
}

/**
 * Sentry deep link URL을 환경변수에서 derive. DSN 미설정이면 null.
 *
 * Sentry web에서 trip lifecycle event를 corrId 기반 검색하기 위한 base URL. 본 PR은
 * "Sentry 진입점만 노출" — corrId 기반 query는 사용자가 Sentry web에서 수동 입력한다
 * (Sentry deep-link search API는 별도 PR scope).
 */
function resolveSentryUrl(): string | null {
  const dsn = process.env[SENTRY_DSN_ENV_VAR];
  if (dsn === undefined || dsn === '') return null;
  // DSN은 https://<key>@<host>/<project> 형태. host에서 organization slug를 derive하기
  // 어렵기 때문에 일반 Sentry web base URL을 반환한다. 사용자는 web에서 corrId 검색.
  return 'https://sentry.io/';
}

/**
 * Token 영역 — corrId 한 줄 + label.
 * tripToken=null이면 caller가 fallback을 그리므로 본 컴포넌트는 호출되지 않는다.
 */
function TokenRow({
  tripToken,
  colors,
}: {
  tripToken: string;
  colors: ReturnType<typeof useTheme>['colors'];
}) {
  return (
    <View style={styles.section} testID="trip-detail-section-token">
      <Text style={[typography.label, { color: colors.muted }]}>Token</Text>
      <Text
        style={[typography.mono, { color: colors.ink }]}
        numberOfLines={1}
        testID="trip-detail-token-value"
      >
        {tripToken}
      </Text>
    </View>
  );
}

/**
 * Lifecycle 영역 — first/last ts + duration + kind counts.
 * kind counts는 KIND_LABELS 순회로 출력 — 새 kind 추가 시 KIND_LABELS만 갱신.
 */
function LifecycleRow({
  detail,
  colors,
}: {
  detail: TripDetail;
  colors: ReturnType<typeof useTheme>['colors'];
}) {
  return (
    <View style={styles.section} testID="trip-detail-section-lifecycle">
      <Text style={[typography.label, { color: colors.muted }]}>Lifecycle</Text>
      <View style={styles.kvRow}>
        <Text style={[typography.mono, { color: colors.subtle }]}>first</Text>
        <Text style={[typography.mono, { color: colors.ink }]}>
          {formatClockTimeWithSeconds(detail.firstTs)}
        </Text>
      </View>
      <View style={styles.kvRow}>
        <Text style={[typography.mono, { color: colors.subtle }]}>last</Text>
        <Text style={[typography.mono, { color: colors.ink }]}>
          {formatClockTimeWithSeconds(detail.lastTs)}
        </Text>
      </View>
      <View style={styles.kvRow}>
        <Text style={[typography.mono, { color: colors.subtle }]}>duration</Text>
        <Text style={[typography.mono, { color: colors.ink }]}>
          {`${Math.round(detail.durationMs / 1000)}s`}
        </Text>
      </View>
      {KIND_LABELS.map((kind) => (
        <View key={kind} style={styles.kvRow} testID={`trip-detail-kind-${kind}`}>
          <Text style={[typography.mono, { color: colors.subtle }]}>{kind}</Text>
          <Text style={[typography.mono, { color: colors.ink }]}>
            {detail.kindCounts[kind]}
          </Text>
        </View>
      ))}
    </View>
  );
}

/** 단일 RawSignalEntry 한 줄 — time | kind | stationId | source/confidence. */
function RawSignalEntryRow({
  entry,
  colors,
}: {
  entry: RawSignalEntry;
  colors: ReturnType<typeof useTheme>['colors'];
}) {
  const stationId = entry.stationId ?? '-';
  const source = entry.source ?? '-';
  const confidence = entry.confidence ?? '-';
  return (
    <View style={styles.kvRow}>
      <Text style={[typography.mono, { color: colors.muted }]}>
        {formatClockTimeWithSeconds(entry.ts)}
      </Text>
      <Text style={[typography.mono, { color: colors.subtle }]}>{entry.kind}</Text>
      <Text style={[typography.mono, { color: colors.ink, flex: 1, textAlign: 'right' }]} numberOfLines={1}>
        {`${stationId} ${source}/${confidence}`}
      </Text>
    </View>
  );
}

/**
 * Raw signal 영역 — entries 최신순.
 * buildTripDetail은 매칭 entries가 0건이면 null을 반환하므로 detail이 non-null이면
 * entries는 항상 ≥1. 별도 empty 분기 없이 list만 렌더.
 */
function RawSignalSection({
  detail,
  colors,
}: {
  detail: TripDetail;
  colors: ReturnType<typeof useTheme>['colors'];
}) {
  return (
    <View style={styles.section} testID="trip-detail-section-raw-signal">
      <Text style={[typography.label, { color: colors.muted }]}>Raw signal</Text>
      <ScrollView style={styles.entriesScroll} testID="trip-detail-raw-signal-list">
        {detail.entries.map((entry, idx) => (
          <RawSignalEntryRow
            key={`${entry.ts}-${idx}`}
            entry={entry}
            colors={colors}
          />
        ))}
      </ScrollView>
    </View>
  );
}

/** Deep link 영역 — Sentry (DSN 설정 시) + raw signal share dump 안내. */
function DeepLinkSection({
  sentryUrl,
  colors,
  onOpenUrl,
}: {
  sentryUrl: string | null;
  colors: ReturnType<typeof useTheme>['colors'];
  onOpenUrl: (url: string) => void;
}) {
  return (
    <View style={styles.section} testID="trip-detail-section-deep-link">
      <Text style={[typography.label, { color: colors.muted }]}>Deep link</Text>
      {sentryUrl !== null ? (
        <Pressable
          onPress={() => onOpenUrl(sentryUrl)}
          testID="trip-detail-deep-link-sentry"
        >
          <Text style={[typography.bodySm, { color: colors.accent }]}>
            View in Sentry
          </Text>
        </Pressable>
      ) : (
        <Text
          style={[typography.mono, { color: colors.muted }]}
          testID="trip-detail-deep-link-sentry-unconfigured"
        >
          (Sentry DSN 미설정)
        </Text>
      )}
      <Text
        style={[typography.bodySm, { color: colors.muted, marginTop: spacing.xs }]}
      >
        share dump → R2 (DebugModal 상단)
      </Text>
    </View>
  );
}

/**
 * TripDetailModal — 단일 trip의 4 영역 drill-down 상세 화면.
 *
 * tripToken=null 또는 매칭 entry 0건 → 4 영역 대신 NO_TRIP_LABEL 표시.
 * onClose는 backdrop / 닫기 버튼 / OS back 3 경로에서 모두 호출 가능.
 */
export function TripDetailModal({ visible, tripToken, onClose }: TripDetailModalProps) {
  const { colors } = useTheme();
  const detail = useTripDetail(tripToken);
  const sentryUrl = resolveSentryUrl();

  const handleOpenUrl = useCallback((url: string) => {
    void Linking.openURL(url);
  }, []);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable
        style={styles.backdrop}
        onPress={onClose}
        testID="trip-detail-backdrop"
      >
        <Pressable
          style={[
            styles.card,
            { backgroundColor: colors.bg, borderColor: colors.hair },
          ]}
          // 카드 내부 탭이 backdrop으로 propagate되지 않도록 onPress no-op.
          onPress={() => {}}
          testID="trip-detail-card"
        >
          {/* 헤더 */}
          <View style={styles.header}>
            <Text style={[typography.label, { color: colors.ink, flex: 1 }]}>
              Trip detail
            </Text>
            <Pressable onPress={onClose} testID="trip-detail-close">
              <Text style={[typography.bodySm, { color: colors.accent, fontWeight: '700' }]}>
                닫기
              </Text>
            </Pressable>
          </View>

          {detail === null ? (
            <Text
              style={[typography.mono, { color: colors.muted, marginTop: spacing.sm }]}
              testID="trip-detail-empty"
            >
              {NO_TRIP_LABEL}
            </Text>
          ) : (
            <>
              <TokenRow tripToken={detail.tripToken} colors={colors} />
              <LifecycleRow detail={detail} colors={colors} />
              <RawSignalSection detail={detail} colors={colors} />
              <DeepLinkSection
                sentryUrl={sentryUrl}
                colors={colors}
                onOpenUrl={handleOpenUrl}
              />
            </>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.md,
  },
  card: {
    width: '100%',
    maxWidth: 420,
    maxHeight: '85%',
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.md,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.xs,
  },
  section: {
    marginTop: spacing.sm,
  },
  kvRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 2,
  },
  entriesScroll: {
    maxHeight: 180,
    marginTop: spacing.xs,
  },
});
