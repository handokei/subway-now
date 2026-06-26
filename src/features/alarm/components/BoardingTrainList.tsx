/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: 이 파일은 의도적으로 여러 features의 hook/util을 조합하는
 * orchestrator 역할이라 직접 import가 본질적이다. Phase 5 enforce 모드에서 file-level disable로
 * 옵트인 처리. 후속 PR(별도 이슈)에서 orchestration 슬라이스(예: features/fusion/, app shell)로
 * 추출하여 disable을 제거할 예정.
 *
 * ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" Phase 5 (#890).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { useTranslation } from 'react-i18next';
import { useTheme, typography, spacing, radius } from '../../../shared/theme';
import { LineBadge } from '../../../shared/ui/LineBadge';
import type { ArrivalInfo } from '../../../shared/types/arrival';
import type { LineNumber, Station } from '../../../shared/types/station';
import { formatClockTime } from '../../../shared/utils/formatTime';
import { arrivalAt } from '../../../shared/utils/arrivalClock';
import { isScheduleFallbackTrainCode } from '../utils/scheduleFallback';
import { recordLockCorrection } from '../utils/lockCorrectionMetrics';
import { buildDirectionMeta } from '../../route/utils/trainLineDirection';
import { parseArrivalDistance } from '../../arrival/utils/arrivalStatusDistance';
import { LINE_COLORS } from '../../../shared/constants/lineColors';
import { buildFallbackSequenceLabel } from '../../../shared/constants/labels';
import stationsData from '../../../data/stations.json';

const allStations = stationsData as Station[];

/** row 좌측 호선 색 stripe 두께(#664). 시각적 구분을 헤더 외에도 row마다 즉시 인지 가능하게. */
const LINE_STRIPE_WIDTH = 3;

/**
 * 지연 노출 임계값(초) — Epic #896 Seam A (#897).
 *
 * BoardingLock이 잡힌 시점의 ETA(initialEtaSeconds)와 현재 폴의 가장 가까운 도착 ETA 차이가
 * 이 값 이상이면 "+N분 지연" 칩을 노출. 30s 폴링 jitter + 약간의 정상 변동을 흡수하면서 사용자가
 * 체감 가능한 단위(3분)를 첫 신호로 잡는다.
 */
const DELAY_NOTICE_THRESHOLD_SECONDS = 180;

/**
 * 낙관적 탭 pending 상태의 자동 rollback 임계값(ms) — #1165 / Epic #1008 C 단기 1번 (B4 경로 1).
 *
 * 사용자가 row를 탭한 직후 onSelect → backend round-trip(BoardingLock 생성) 대기 동안 pending 상태로
 * 시각 피드백을 노출한다. 이 시간 안에 부모가 `lockedTrainCode`로 확정 신호를 주지 않으면 pending을
 * 자동 해제(rollback)해 stuck 상태를 방지한다. 30s 폴 + 모바일 RTT P95(~3s)를 고려해 5s로 설정.
 */
const PENDING_TIMEOUT_MS_DEFAULT = 5000;

/** pending row 시각 피드백 — accent 색 테두리 두께. row의 borderLeft stripe와 별도 외곽 outline. */
const PENDING_BORDER_WIDTH = 2;

/**
 * #1366 Layer 1 — release-after-tap 보호 윈도우(ms).
 *
 * 사용자가 하차/재탑승을 짧은 간격으로 반복할 때(item 4 8:33 환승역 trip) lockedTrainCode가
 * 비동기로 null로 전환되면서 pending 상태가 잠깐 풀려 새 탭이 즉시 발사되는 race가 관측됐다.
 * lockedTrainCode가 non-null → null로 전환된 직후 이 시간 동안 handlePress를 차단해
 * 직전 release/cron round-trip이 완료될 시간을 보장한다.
 *
 * 너무 길면 의도된 재탑승이 막히므로 백엔드 round-trip P95(~3s)를 고려해 짧게 잡는다.
 */
const RELEASE_GUARD_MS = 800;

/**
 * Loading skeleton row 개수 — #1177. 첫 폴링 응답 도착 전 시각적 placeholder.
 *
 * 도착 list는 일반적으로 1~3건이 도착하므로 3행이면 실제 데이터와 시각적 부피 차이가 적어
 * 응답 도착 시 layout shift가 최소화된다. key를 명시 상수 배열로 분리해 map 순회로 렌더 →
 * 글로벌 룰 3(데이터 주도, 인덱스 하드코딩 금지) 준수.
 */
const SKELETON_ROW_KEYS = ['s1', 's2', 's3'] as const;

interface Props {
  arrivals: ArrivalInfo[];
  line: LineNumber;
  onSelect: (train: ArrivalInfo) => void;
  /**
   * 도착 시각이 이 값보다 빠른 열차는 disabled로 렌더 (#584 PR E). 단위: 초.
   * 환승 list에서 도보 buffer 표현용. 미전달 시 모든 열차 활성.
   */
  walkingBufferSeconds?: number;
  /** 헤더 라벨 커스텀 (환승 list 등). 미전달 시 home.boardingTrainListTitle i18n 키. compact=true면 무시. */
  title?: string;
  /**
   * 다음 인접역 라벨(#649, #749, #807). 있으면 "<label>방면"만 노출(종착 제거).
   * 호출자가 resolveNextAdjacentStationName으로 계산해 전달. null/미전달이면 종착 fallback.
   */
  nextStationLabel?: string | null;
  /**
   * Timeline hop slot 안 inline 배치용 컴팩트 모드(#649). 헤더/카드 배경 제거,
   * row padding 축소, 폰트 한 단계 다운, trainCode 라인 생략.
   */
  compact?: boolean;
  /**
   * 활성 BoardingLock의 탑승 시점 ETA 스냅샷(초) — Epic #896 Seam A (#897).
   *
   * 가장 가까운 도착 train의 arrivalSeconds가 이 값보다 DELAY_NOTICE_THRESHOLD_SECONDS 이상 늘었다면
   * 같은 trainCode 유지 동안 누적 지연이 발생한 것으로 보고 "+N분 지연" 칩을 노출한다.
   * 미전달이면 칩 미노출 — lock 없는 상태(예: misBoarding 재선택)나 레거시 lock에서도 안전.
   */
  initialEtaSeconds?: number;
  /**
   * 현재 활성 BoardingLock의 trainCode — #1165 낙관적 탭 확정 신호.
   *
   * 사용자가 row를 탭하면 컴포넌트가 즉시 pending 상태로 시각 피드백을 보여주고 onSelect를 호출한다.
   * 부모는 backend round-trip 완료 후 이 prop을 새 lock의 trainCode로 갱신한다. pendingTrainCode와
   * 일치하면 pending이 confirmed로 전환되며 rollback timer가 해제된다. 미일치 또는 timeout 시에는
   * pending이 자동 해제(rollback). 미전달 시 pending은 timeout으로만 해제된다.
   */
  lockedTrainCode?: string | null;
  /**
   * pending 자동 rollback timeout(ms) — #1165. 미전달 시 PENDING_TIMEOUT_MS_DEFAULT(5000ms).
   * 테스트/조정용 노출.
   */
  pendingTimeoutMs?: number;
  /**
   * 도착 정보 로딩 중 여부 — #1177 (Epic #1008 C 단기 / B4 UX).
   *
   * true이면 arrivals 내용에 상관없이 loading skeleton(placeholder rows) 노출.
   * 첫 폴링 응답 도착 전 또는 명시적 refresh 동안 사용. 기본 false → 기존 동작 유지.
   *
   * 우선순위: error > loading > empty > data. loading과 error가 동시에 true이면 error 우선
   * (실패한 재시도 중에는 사용자가 무엇이 잘못됐는지 먼저 인지하도록).
   */
  loading?: boolean;
  /**
   * 도착 정보 로딩 실패 메시지 — #1177.
   *
   * null/undefined면 error state 아님. 객체이면 error UI 렌더(메시지 + 자동 재시도 안내).
   * `message`가 비어 있어도 default 카피(home.boardingTrainListError)로 fallback.
   *
   * 호출자는 fetch 실패/timeout/parse 실패 등을 받아 전달한다. 본 컴포넌트는 retry 로직을
   * 보유하지 않으며 호출자(useArrivalInfo polling)가 다음 tick에 자동 재시도하는 흐름을 전제.
   */
  error?: { message?: string | null } | null;
  /**
   * backend round-trip이 사용자가 탭한 train과 다른 trainCode로 lock을 확정했을 때 발화 — #1166.
   *
   * pending(`pendingTrainCode`)과 부모가 전달한 `lockedTrainCode`가 모두 set이지만 서로 다른 값이면
   * 본 컴포넌트가 pending을 즉시 해제하고 callback을 호출한다. 부모는 toast UX로 사용자에게 정정 사실을
   * 알린다. 같은 값으로 확정되는 정상 케이스(`lockedTrainCode === pendingTrainCode`)에서는 호출되지 않는다.
   * 미전달이면 내부 로직(pending 해제 + metric 적재)은 그대로 수행되고 callback만 skip.
   */
  onLockCorrected?: (pendingTrainCode: string, confirmedTrainCode: string) => void;
  /**
   * #1888 (RC-13) — fallback 모드 사유. set 상태에서 list가 empty가 되면 일반 empty placeholder 대신
   * 더 명시적인 fallback 메시지("탑승 후보를 찾을 수 없어요")를 렌더한다.
   *
   * 호출자(HomeScreen / useBoardingPromptResponder 등)가 boarding-prompt 응답 후 자동 lock이
   * ambiguity/empty/lookup 실패로 fallback된 컨텍스트에서 이 prop을 전달. set 안 됐거나 list가
   * 비어있지 않으면 기존 동작 그대로(empty placeholder / 정상 list). loading/error state가 우선순위
   * 더 높음 (error > loading > fallback-empty > empty > data).
   */
  fallbackReason?: 'autolock-empty' | 'autolock-ambiguity' | 'autolock-station-lookup' | null;
}

/**
 * 현재역 도착 list — 사용자가 탑승할 열차를 명시적으로 선택하는 진입점 (#584 PR B).
 *
 * 호출자는 route 방향으로 필터링된 arrivals를 전달한다. 노선(line) 필터는 컴포넌트가 내부에서 수행
 * (#664): 환승역 statnNm 응답이 다른 노선 열차를 섞어 보내므로 헤더 line 기준으로 한 번 더 걸러
 * caller 세 곳(index/MisBoardingReselectModal/useTransferTrainList)이 동일 보호를 받는다.
 *
 * 각 row를 탭하면 onSelect 콜백이 발화 → 호출자가 BoardingLock 생성.
 *
 * #634: 도착 시각을 "분" 상대 표기 → "HH:mm" 절대 표기.
 * #649: compact + nextStationLabel — Timeline hop slot 안에 inline 배치되는 형태 지원.
 *       compact 모드는 hop slot 안 inline이라 row borderRadius 없음(직각). stripe도 같은 정신으로
 *       직각 유지 — 일반 모드는 카드 radius와 어울리는 둥근 코너 stripe로 자연스럽게 처리됨.
 * #749: 2줄 row 레이아웃 — 첫째 줄 "{종착}{방면?}" (방면은 옵셔널), 둘째 줄 "{거리} · {HH:mm} 도착 예정".
 *       카운터는 호출자가 전달한 배열 순서를 1-indexed로 변환. 같은 trainCode가 유지되는 동안
 *       카운터 안정 → "같은 열차 지연" 신호.
 * #790: 거리 표기를 API `arvlMsg2`에서 정규식 파싱한 실거리로 변경 (`parseArrivalDistance`).
 *       비어있는 statusMessage(주로 mock/schedule fallback)는 `${index+1}번째 전`로 fallback.
 * #855: fallback 라벨을 "약 N정거장 전 (약 M분 후)"로 변경. 단위(정거장/분) 명시로 mock/schedule
 *       fallback 시 사용자가 거리/시간을 인지할 수 있게 함. 라벨 텍스트는 `constants/labels.ts`
 *       에 분리하여 JSX 하드코딩 금지(글로벌 룰 3).
 * #792: 종착 표기는 `parseTrainLineDirection`로 i18n 정규화한다 (기존 하드코딩 "행" 부착 제거).
 * #805: "곧 도착"/"전역 출발"/"당역 도착" 등 statusMessage가 sequence 슬롯을 차지하는 임박 상태에서
 *       도착 예정 HH:mm 시간 라벨이 같은 줄에서 가려지는 회귀가 있었다. 시간 라벨을 항상 별도 라인
 *       으로 분리해 "상태 텍스트(또는 거리) → 시간"이 위아래로 명확히 보이도록 한다.
 * #807: 첫째 줄은 종착(마천행/방화행 등)이 아니라 **다음 인접역 방면**만 표시(`buildDirectionMeta`).
 *       nextStationLabel 미전달 시에만 종착 fallback. 종착 분기 누락 회귀(5호선 등) 완전 차단.
 */
export function BoardingTrainList({
  arrivals,
  line,
  onSelect,
  walkingBufferSeconds,
  title,
  nextStationLabel = null,
  compact = false,
  initialEtaSeconds,
  lockedTrainCode = null,
  pendingTimeoutMs = PENDING_TIMEOUT_MS_DEFAULT,
  loading = false,
  error = null,
  onLockCorrected,
  fallbackReason = null,
}: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  // #1165 낙관적 탭 — 즉시 시각 피드백 + 중복 탭 방지.
  // pendingTrainCode가 set되어 있으면 그 row가 pending highlight, 다른 row는 disabled.
  const [pendingTrainCode, setPendingTrainCode] = useState<string | null>(null);
  const rollbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // #1366 Layer 1 — release-after-tap 보호. lockedTrainCode가 non-null → null로 전환되면
  // 이 ref에 epoch ms를 기록하고, handlePress는 RELEASE_GUARD_MS 안의 탭을 무시한다.
  // 사용자가 빠르게 하차→재탑승할 때 backend round-trip이 끝나기 전 stale state로 새 lock이
  // POST되어 cron "trainCode not found" 회귀로 이어지는 race(item 4)를 차단한다.
  const isReleasingRef = useRef<boolean>(false);
  const releaseGuardTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevLockedTrainCodeRef = useRef<string | null | undefined>(lockedTrainCode);

  const clearRollbackTimer = useCallback(() => {
    if (rollbackTimerRef.current != null) {
      clearTimeout(rollbackTimerRef.current);
      rollbackTimerRef.current = null;
    }
  }, []);

  // 부모가 lockedTrainCode로 확정 신호 → pending 해제. 본 컴포넌트는 pending 상태만 책임진다.
  // #1166: lockedTrainCode가 pendingTrainCode와 다른 값으로 확정되면 정정(round-trip correction).
  //   pending 즉시 해제 + metric 적재 + onLockCorrected callback 호출 → 부모가 toast UX로 표기.
  //   metric은 callback 미전달 케이스에서도 적재(테스트/배포 직후 wiring 누락 회귀 차단).
  useEffect(() => {
    if (pendingTrainCode == null || lockedTrainCode == null) return;
    if (lockedTrainCode === pendingTrainCode) {
      clearRollbackTimer();
      setPendingTrainCode(null);
      return;
    }
    // 정정 — pending(A) ≠ confirmed(B).
    clearRollbackTimer();
    recordLockCorrection(pendingTrainCode, lockedTrainCode);
    onLockCorrected?.(pendingTrainCode, lockedTrainCode);
    setPendingTrainCode(null);
  }, [lockedTrainCode, pendingTrainCode, clearRollbackTimer, onLockCorrected]);

  // unmount 시 timer 정리.
  useEffect(() => clearRollbackTimer, [clearRollbackTimer]);

  // #1366 Layer 1 — lockedTrainCode가 non-null → null로 전환되면 RELEASE_GUARD_MS 동안
  // handlePress를 차단. 사용자 명시 release/하차/auto-release 어느 경로든 동일 윈도우 적용.
  useEffect(() => {
    const prev = prevLockedTrainCodeRef.current;
    prevLockedTrainCodeRef.current = lockedTrainCode;
    if (prev != null && lockedTrainCode == null) {
      isReleasingRef.current = true;
      if (releaseGuardTimerRef.current != null) {
        clearTimeout(releaseGuardTimerRef.current);
      }
      releaseGuardTimerRef.current = setTimeout(() => {
        isReleasingRef.current = false;
        releaseGuardTimerRef.current = null;
      }, RELEASE_GUARD_MS);
    }
  }, [lockedTrainCode]);

  // unmount 시 release guard timer도 정리.
  useEffect(() => {
    return () => {
      if (releaseGuardTimerRef.current != null) {
        clearTimeout(releaseGuardTimerRef.current);
        releaseGuardTimerRef.current = null;
      }
    };
  }, []);

  const handlePress = useCallback(
    (train: ArrivalInfo) => {
      // #1366 Layer 1 — 직전 release 후 보호 윈도우 안이면 무시. backend round-trip이 끝나기 전
      // stale state로 새 lock POST → cron "trainCode not found" 회귀(item 4) 차단.
      if (isReleasingRef.current) return;
      // 이미 다른 row가 pending이면 무시(중복 탭 방지). 같은 row 재탭도 무시.
      if (pendingTrainCode != null) return;
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      setPendingTrainCode(train.trainCode);
      clearRollbackTimer();
      rollbackTimerRef.current = setTimeout(() => {
        setPendingTrainCode(null);
        rollbackTimerRef.current = null;
      }, pendingTimeoutMs);
      onSelect(train);
    },
    [pendingTrainCode, clearRollbackTimer, pendingTimeoutMs, onSelect],
  );
  // #915 후속: 헤더 라벨/empty placeholder를 i18n으로 분리.
  // 4 locales(ko/en/ja/zh) 비-한국어 사용자가 핵심 baseline UX("탑승할 열차 선택")를 모국어로 본다.
  const headerTitle = title ?? t('home.boardingTrainListTitle');
  const isUnreachable = (train: ArrivalInfo): boolean =>
    walkingBufferSeconds != null && train.arrivalSeconds < walkingBufferSeconds;

  // #664: 환승역 statnNm 응답에 같은 이름 다른 노선 열차가 섞여 들어오므로 헤더 line 기준 필터.
  // train.line은 어댑터가 subwayId로 row마다 정확히 결정한 값(#663). 일치하는 row만 표시.
  const filteredArrivals = arrivals.filter((train) => train.line === line);

  // #897 Seam A: 가장 가까운 도착 ETA가 lock 시점보다 +180s 이상이면 누적 지연(분) 노출.
  // arrivals는 호출자가 도착시간 오름차순으로 전달한다는 컨벤션을 따른다(#749 카운터와 동일 가정).
  const delayMinutes = computeDelayMinutes(filteredArrivals, initialEtaSeconds);

  // #1177: 4가지 state 구분 — error > loading > empty > data. 낙관적 UI 도입(#1165) 후
  // 빈 list/loading의 의미를 사용자에게 명확히 전달한다.
  if (error != null) {
    const message =
      error.message != null && error.message.length > 0 ? error.message : t('home.boardingTrainListError');
    return (
      <View
        style={compact ? styles.emptyCompact : styles.empty}
        testID="boarding-train-list-error"
        accessibilityRole="alert"
        accessibilityLabel={t('a11y.alarm.boardingTrainListErrorLabel')}
      >
        <Text style={[typography.bodySm, { color: colors.danger, fontWeight: '600' }]}>{message}</Text>
        <Text style={[typography.bodySm, { color: colors.muted }]}>{t('home.boardingTrainListErrorHint')}</Text>
      </View>
    );
  }

  if (loading) {
    return (
      <View
        style={compact ? styles.containerCompact : styles.container}
        testID="boarding-train-list-loading"
        accessibilityLabel={t('a11y.alarm.boardingTrainListLoadingLabel')}
        accessibilityState={{ busy: true }}
      >
        {!compact && (
          <View style={styles.header}>
            <LineBadge line={line} />
            <Text style={[typography.label, { color: colors.muted }]}>{headerTitle}</Text>
          </View>
        )}
        {SKELETON_ROW_KEYS.map((key) => (
          <View
            key={key}
            style={[
              compact ? styles.rowCompact : styles.row,
              compact ? null : { backgroundColor: colors.card },
              { borderLeftWidth: LINE_STRIPE_WIDTH, borderLeftColor: LINE_COLORS[line] },
              styles.skeletonRow,
              { backgroundColor: colors.card },
            ]}
            testID={`boarding-train-list-skeleton-${key}`}
          >
            <View style={[styles.skeletonBar, { backgroundColor: colors.muted, opacity: 0.2, width: '60%' }]} />
            <View style={[styles.skeletonBar, { backgroundColor: colors.muted, opacity: 0.15, width: '40%' }]} />
          </View>
        ))}
      </View>
    );
  }

  // #1888 (RC-13) — fallbackReason이 set + list가 empty면 더 명시적인 fallback 메시지.
  // 일반 empty placeholder("도착 예정 열차가 없습니다 / 잠시 후 자동으로 다시 확인")는 polling 회복을
  // 전제하는 일시적 상태인 반면, 본 분기는 boarding-prompt 응답 후 자동 lock 실패가 확정된 상태라
  // 사용자에게 "역 근처에서 다시 시도하거나 직접 선택" 액션을 명확히 안내한다.
  if (fallbackReason != null && filteredArrivals.length === 0) {
    return (
      <View
        style={compact ? styles.emptyCompact : styles.empty}
        testID="boarding-train-list-fallback"
        accessibilityRole="alert"
        accessibilityLabel={t('a11y.alarm.boardingTrainListFallbackLabel')}
      >
        <Text style={[typography.bodySm, { color: colors.muted, fontWeight: '600' }]}>
          {t('home.boardingTrainListFallback')}
        </Text>
        <Text style={[typography.bodySm, { color: colors.subtle }]}>
          {t('home.boardingTrainListFallbackHint')}
        </Text>
      </View>
    );
  }

  if (filteredArrivals.length === 0) {
    return (
      <View
        style={compact ? styles.emptyCompact : styles.empty}
        testID="boarding-train-list-empty"
        accessibilityLabel={t('a11y.alarm.boardingTrainListEmptyLabel')}
      >
        <Text style={[typography.bodySm, { color: colors.muted }]}>{t('home.boardingTrainListEmpty')}</Text>
        <Text style={[typography.bodySm, { color: colors.subtle }]}>{t('home.boardingTrainListEmptyHint')}</Text>
      </View>
    );
  }

  return (
    <View
      style={compact ? styles.containerCompact : styles.container}
      testID="boarding-train-list"
    >
      {!compact && (
        <View style={styles.header}>
          <LineBadge line={line} />
          <Text style={[typography.label, { color: colors.muted }]}>{headerTitle}</Text>
        </View>
      )}
      {delayMinutes != null && (
        <View
          style={[styles.delayChip, { borderColor: colors.danger }]}
          testID="boarding-train-delay-chip"
        >
          <Text style={[styles.delayChipText, { color: colors.danger }]}>{`+${delayMinutes}분 지연`}</Text>
        </View>
      )}
      {/* #1177 — pending lock state list-level 안내. row outline highlight와 별도로 list 헤더 영역에
          상태 텍스트를 노출해 사용자에게 "탭이 처리 중" 임을 명시. row outline만으로는 작은 시각적
          시그널이라 접근성과 명료성을 위해 텍스트 라인 추가. */}
      {pendingTrainCode != null && (
        <View
          style={styles.pendingNotice}
          testID="boarding-train-list-pending-notice"
          accessibilityLabel={t('a11y.alarm.boardingTrainListPendingLabel')}
        >
          <Text style={[typography.bodySm, { color: colors.accent, fontWeight: '600' }]}>
            {t('home.boardingTrainListPending')}
          </Text>
        </View>
      )}
      {filteredArrivals.map((train, index) => {
        const unreachable = isUnreachable(train);
        // #1165 — 다른 row가 pending이면 이 row는 disabled. 같은 row가 pending이면 highlight.
        const isPending = pendingTrainCode === train.trainCode;
        const isPendingBlocked = pendingTrainCode != null && !isPending;
        const disabled = unreachable || isPendingBlocked;
        // #792: 종착·방면 라벨을 i18n 정규화 + dedup. nextStationLabel 미전달이면 종착만.
        const metaText = buildDirectionMeta(train.destination, nextStationLabel, allStations);
        // #790: API arvlMsg2 기반 진짜 거리 표시. 비어있으면 mock/schedule fallback 경로 —
        // #855에서 fallback 라벨을 "약 N정거장 전 (약 M분 후)"로 단위 명시. arrivalSeconds가 0
        // 이하면 분 라벨 생략.
        const parsedDistance = parseArrivalDistance(train.statusMessage);
        const sequenceText =
          parsedDistance.length > 0
            ? parsedDistance
            : buildFallbackSequenceLabel(index, train.arrivalSeconds);
        const arrivalText = `${formatArrivalClock(train)} 도착 예정`;
        return (
          <Pressable
            key={train.trainCode}
            onPress={() => handlePress(train)}
            disabled={disabled}
            style={[
              compact ? styles.rowCompact : styles.row,
              compact ? null : { backgroundColor: colors.card },
              { borderLeftWidth: LINE_STRIPE_WIDTH, borderLeftColor: LINE_COLORS[train.line] },
              isPending && {
                borderWidth: PENDING_BORDER_WIDTH,
                borderColor: colors.accent,
              },
              { opacity: unreachable ? 0.4 : isPendingBlocked ? 0.5 : 1 },
            ]}
            testID={`boarding-train-row-${train.trainCode}`}
            accessibilityRole="button"
            accessibilityLabel={t('a11y.alarm.boardingTrainSelectLabel', {
              meta: metaText,
              sequence: sequenceText,
              arrival: arrivalText,
            })}
            accessibilityHint={t('a11y.alarm.boardingTrainSelectHint')}
            accessibilityState={{ disabled, busy: isPending }}
          >
            <View style={styles.rowContent}>
              {/* #1165 pending marker — 테스트/스크린리더 접근용. 시각적 highlight는 outline border로 처리.
                  Pressable의 accessibilityState.busy=true가 이미 스크린리더에 pending을 전달하므로
                  marker 자체는 의미 없는 0×0 View. testID만 노출. */}
              {isPending && (
                <View
                  style={styles.pendingMarker}
                  testID={`boarding-train-pending-${train.trainCode}`}
                />
              )}
              <View style={styles.rowMetaLine}>
                <Text
                  style={[
                    compact ? typography.bodySm : typography.body,
                    { color: colors.ink, flex: 1 },
                  ]}
                  testID={`boarding-train-meta-${train.trainCode}`}
                >
                  {metaText}
                </Text>
                {/* trainCode/시간표 배지는 일반 모드에서만 노출. compact는 timeline hop slot 안 inline이라 정보 밀도 최소화. */}
                {!compact &&
                  (isScheduleFallbackTrainCode(train.trainCode) ? (
                    <Text style={[typography.mono, { color: colors.subtle }]}>시간표</Text>
                  ) : (
                    <Text style={[typography.mono, { color: colors.muted }]}>{train.trainCode}</Text>
                  ))}
              </View>
              {/* #805: sequence(거리/상태)와 시간 라벨은 별도 라인으로 분리.
                  sequenceText가 "전역 출발"/"당역 도착"/"4번째 전" 등 어떤 길이여도 시간 라벨이
                  같은 줄에서 가려지지 않는다. sequenceText가 비어 있으면 그 라인은 미렌더하지만
                  시간 라벨 라인은 항상 표시한다. */}
              {sequenceText.length > 0 && (
                <View style={styles.rowSequenceLine}>
                  <Text
                    style={[typography.bodySm, { color: colors.muted }]}
                    testID={`boarding-train-sequence-${train.trainCode}`}
                  >
                    {sequenceText}
                  </Text>
                </View>
              )}
              <View style={styles.rowArrivalLine}>
                <Text
                  style={[typography.bodySm, { color: colors.accent, fontWeight: '600' }]}
                  testID={`boarding-train-arrival-${train.trainCode}`}
                >
                  {arrivalText}
                </Text>
              </View>
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * 도착 시각 절대 표기(HH:mm) — #634, #897.
 *
 * #897 Seam A: anchor를 receivedAtMs+arrivalSeconds → `arrivalAt(train)` (현재 시각 + 남은 초)로 통일.
 * useArrivalCountdown이 tick마다 arrivalSeconds를 1씩 줄이는 동안 시계도 1초 흐르므로 anchor가 stable.
 * ArrivalRow(useCountdown 기반)와 같은 row의 시각이 항상 일치한다.
 */
function formatArrivalClock(train: ArrivalInfo): string {
  return formatClockTime(arrivalAt(train));
}

/**
 * 지연(분) 계산 — Epic #896 Seam A (#897).
 *
 * 가장 가까운 도착의 arrivalSeconds가 초기 ETA보다 임계값(180초) 이상 늘면 그 차이를 분 단위 올림으로 반환.
 * 미만이면 null(칩 미노출). initialEta 미전달이나 0 이하(임박/baseline 없음)도 null.
 * 호출자가 정렬을 보장하지 않을 수 있으므로 본 함수가 arrivalSeconds 오름차순 정렬 후 nearest 선택.
 */
function computeDelayMinutes(
  arrivals: ArrivalInfo[],
  initialEtaSeconds: number | undefined,
): number | null {
  if (initialEtaSeconds == null || initialEtaSeconds <= 0) return null;
  if (arrivals.length === 0) return null;
  const [head, ...rest] = arrivals;
  const nearest = rest.reduce(
    (min, cur) => (cur.arrivalSeconds < min.arrivalSeconds ? cur : min),
    head,
  );
  const diff = nearest.arrivalSeconds - initialEtaSeconds;
  if (diff < DELAY_NOTICE_THRESHOLD_SECONDS) return null;
  return Math.ceil(diff / 60);
}

const styles = StyleSheet.create({
  container: {
    gap: spacing.sm,
  },
  containerCompact: {
    gap: spacing.xs,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: spacing.lg,
    borderRadius: radius.md,
  },
  rowCompact: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
  },
  rowContent: {
    flex: 1,
    gap: spacing.xs,
  },
  rowMetaLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  rowSequenceLine: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  rowArrivalLine: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  empty: {
    padding: spacing.lg,
    alignItems: 'center',
    gap: spacing.xs,
  },
  emptyCompact: {
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
    gap: spacing.xs,
  },
  // #1177 — loading skeleton row 내부 bar. 색은 인라인으로 muted/opacity 적용.
  skeletonRow: {
    gap: spacing.xs,
    borderRadius: radius.md,
  },
  skeletonBar: {
    height: 10,
    borderRadius: 4,
  },
  // #1177 — pending list-level notice. row outline 외에 list 영역 상단에 텍스트 한 줄 노출.
  pendingNotice: {
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.xs,
  },
  // #897 — outline 칩. ArrivalStatusBadge의 outline variant와 동일 외형(borderWidth 1 + radius 3).
  delayChip: {
    alignSelf: 'flex-start',
    paddingHorizontal: spacing.xs,
    paddingVertical: 1,
    borderRadius: 3,
    borderWidth: 1,
  },
  delayChipText: { ...typography.micro, fontWeight: '700', letterSpacing: 0 },
  // #1165 — pending 상태 visual은 row outline border로 처리. 별도 marker는 0×0 invisible View.
  // 테스트에서 testID로 pending 진입을 확인하기 위함이며, layout/접근성에 영향을 주지 않는다.
  pendingMarker: { width: 0, height: 0 },
});
