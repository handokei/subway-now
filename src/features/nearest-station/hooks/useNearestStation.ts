import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import * as Location from 'expo-location';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { NearestStationResult, Station } from '../../../shared/types/station';
import { BG_LAST_STATION_KEY } from '../../../shared/constants/storageKeys';
import { findNearestStations } from '../utils/findNearestStation';
import {
  isAccuracyAcceptable,
  isAccuracyAcceptableForDisplay,
  isLocationFresh,
  isPlausibleJump,
  type FixSample,
} from '../utils/locationGates';
import {
  MAX_ACCURACY_M,
  MAX_ACCURACY_M_DISPLAY,
  MAX_LOCATION_AGE_MS,
  MAX_STATION_DISTANCE_KM,
  FG_WATCH_SURFACE_TIME_INTERVAL_MS,
  FG_WATCH_SUBSURFACE_TIME_INTERVAL_MS,
  isValidGpsSpeedMps,
} from '../../../shared/constants/location';
import { E2E_MOCK_LOCATION, IS_E2E_MOCK } from '../../../shared/constants/e2e';
import {
  appStateToGpsActive,
  currentGpsActive,
  type GpsActiveState,
} from '../../../shared/constants/gpsStatus';
import { createLogger } from '../../../shared/utils/logger';
import { pushFusionDebugEntry } from '../utils/fusionDebugBuffer';
import { pushGpsDropEntry } from '../utils/gpsDropBuffer';
import { haversine } from '../../../shared/utils/haversine';
import { useStickyStation } from './useStickyStation';
import { usePolling } from '../../../shared/hooks/usePolling';
import {
  isGpsQualityGateAcceptable,
  gpsQualityDropReason,
  isGpsQualityJumpDegraded,
  isGpsQualityAbsenceDegraded,
  isGpsQualityHysteresisReleased,
} from '../utils/gpsQualityGate';
import { GPS_QUALITY_GATE_TIMER_INTERVAL_MS } from '../../../shared/constants/gpsQualityGate';

/** #876 — useNearestStation 표시값의 출처. sticky lock된 역이면 'sticky', 아니면 GPS live.
 *  알람 트리거에는 영향 없음 — 호출자가 출처별 UX(예: "탑승 전 추정")를 분기할 수 있게 노출. */
export type NearestStationSource = 'sticky' | 'live';

const logger = createLogger('useNearestStation');

const MIN_DISTANCE_CHANGE_KM = 0.003; // 3m — UI 갱신을 자주 흘려보낸다.

// #1516 — gps-drop rate limit. 1초 윈도우에서 이 수치 이상 push되면 추가 push는 skip하고
// 윈도우 종료 시 1건의 "rate-limited" summary entry로 흡수한다. 실측(2026-06-19) 5분 84건
// (~17 drops/min 평균, peak 동일 ts 다발 ≥18) 대비 정상 진단성(<10/min)에 맞춘 임계.
const GPS_DROP_PER_SEC_LIMIT = 2;
const GPS_DROP_WINDOW_MS = 1000;

// #1313 — subsurface 여부로 갈리는 FG watch 옵션. accuracy 선택 + interval을 한 데이터로 묶어
// startWatch가 throttle boolean만 보고 분기 없이 선택하게 한다(하드코딩 분기 회피).
// #1440 — surface는 distanceInterval=0으로 되돌린다. #1416에서 5m로 throttle한 결과 정적 FG
// 30분에 GPS acc 회복 실패(acc>30m stuck) + 한양대 820m 같은 stuck fix 오인 fire가 관측됐다.
// iOS Core Location은 distanceInterval>0일 때 distanceFilter 활성 → 정적 상태에서 callback 자체가
// 끊기고, OS가 GPS fix 정밀도를 재조정하지 못해 stale acc가 그대로 굳어 ADR-015 §3 합의 게이트의
// strong A 신호(acc≤30m + 거리≤100m)가 영구 미달이 된다. fg fire path cascade는 #1416-B의
// useStationAlarm effect short-circuit으로 별개 layer에서 해소됐으므로 GPS callback throttle을
// 제거해도 cascade가 재발하지 않는다.
// subsurface는 동일하게 distanceInterval=0 — 지하 indoor positioning 보강 동안에는 매 fix가 필요.
// #1983 (ADR-022 A3) — subsurface에서도 한때 Accuracy.High로 통일했었다. 원 근거: Balanced(100m~
// 수km, cellular triangulation)는 지상 fix까지 1000~1600m 저정확도로 오염시키는 회귀(7/1 오후,
// 6/30 여러 로그) 발생 — "지하 fix가 있을 때 정확도 확보"가 목적이었다(당시 결정 코멘트 원문).
// #2100 (#2093 F) — 그 후 #2074 품질 게이트(100m/15s)가 지하 fix를 SSOT/알람 어디에도 쓰지 않고
// 전량 폐기하는 것이 실측으로 확인(7/7 로그 gps-drop 84건, 최대 3,467m) — Balanced가 지하 구간에서
// 만드는 저정확도 fix는 애초에 게이트가 다 버리므로 #1983의 "지하 fix 정확도 확보" 근거가 지하
// 구간 자체에는 더 이상 적용되지 않는다. #1983이 막으려던 "지상 fix 오염"은 지상 복귀를 GPS 게이트
// 통과 fix 재등장(hysteresis)에만 의존하지 않고 즉시 원복(아래 profileWatchDegraded eager release +
// barometerSubsurface)하는 것으로 차단한다 — Balanced의 느린/부정확 첫 fix로 원복 감지 자체가
// 늦어지는 악순환을 끊는다. subsurface는 timeInterval 12s throttle 유지, accuracy만 Balanced로
// 재전환해 지하 무의미 GPS 삼각측량 재시도(발열 주범)를 낮춘다.
const FG_WATCH_OPTIONS_SURFACE: Location.LocationOptions = {
  accuracy: Location.Accuracy.High,
  distanceInterval: 0,
  timeInterval: FG_WATCH_SURFACE_TIME_INTERVAL_MS,
};
const FG_WATCH_OPTIONS_SUBSURFACE: Location.LocationOptions = {
  accuracy: Location.Accuracy.Balanced,
  distanceInterval: 0,
  timeInterval: FG_WATCH_SUBSURFACE_TIME_INTERVAL_MS,
};

// throttle 여부로 watch 옵션을 고른다. true(지하 확정)면 throttle, false면 지상 기본값.
// 확신 없이(undefined/false) GPS를 낮추지 않는다 — 호출부가 === true로 좁힌 boolean만 넘긴다(#1313).
function fgWatchOptionsFor(throttled: boolean): Location.LocationOptions {
  return throttled ? FG_WATCH_OPTIONS_SUBSURFACE : FG_WATCH_OPTIONS_SURFACE;
}

// userLocation/result는 표시용 완화 게이트(MAX_ACCURACY_M_DISPLAY=1500m)를 통과한 좌표로 갱신된다.
// 알람 발화 경로에서 이 값을 ETA/거리 계산에 사용할 경우 반드시 accuracyMeters와 함께 묶어
// 알람 엄격 게이트(isAccuracyAcceptable, MAX_ACCURACY_M=200m)를 먼저 통과시켜야 한다.
// 예: useStationAlarm는 effect 진입부에서 isAccuracyAcceptable(accuracyMeters) early return으로
// 이 계약을 강제한다.
interface UseNearestStationReturn {
  result: NearestStationResult | null;
  /**
   * #1486 (ADR-015 §2) — sticky override 없는 live GPS 최근접 결과.
   *
   * `result`는 sticky lock이 활성이고 다른 역이면 sticky station으로 override된다(`exposed` 로직).
   * fire path(`useFusedNearestStation` cascade fallback → `useStationAlarm.nearestStation`)가 sticky
   * 결과를 받지 않도록 호출자(useFusedNearestStation)는 본 필드를 사용한다.
   *
   * sticky 비활성 시 `result`와 동일 reference — 추가 cost 없음.
   * sticky 활성 + 다른 역 lock 시 `result`는 sticky station, `liveResult`는 GPS 최근접 그대로.
   *
   * ADR-015 §2 — sticky:locked fire 권한 영구 박탈, UI 표시 채널만 유지.
   */
  liveResult: NearestStationResult | null;
  /**
   * #1486 (ADR-015 §2) — sticky lock 정보 표시 전용 채널.
   *
   * sticky lock 활성 시 lock된 station만 노출. lock 비활성 시 null.
   * fire path 진입 금지 — DebugModal/UI 추적 신호 표시에만 사용.
   *
   * 호출자(useFusedNearestStation)가 표시 채널로 그대로 통과시킨다.
   */
  stickyDisplayOnly: Station | null;
  variants: Station[];
  userLocation: { lat: number; lng: number } | null;
  speedMps: number | null;
  accuracyMeters: number | null;
  loading: boolean;
  error: string | null;
  permissionDenied: boolean;
  // true: 직전 좌표가 표시 게이트(MAX_ACCURACY_M_DISPLAY)에 의해 drop되어 result가
  // 마지막 신뢰 fix로 정지된 상태. 호출자는 "위치 확인 중" 상태로 표시한다.
  locationUncertain: boolean;
  // #852: GPS watch 구독 활성 여부. AppState 'active' 동안만 'fg', 그 외(BG/inactive)는 'bg'.
  // silent push wake 시에도 'bg' — 사용자가 디버그 모달에서 "왜 안 바뀌지" 확인 가능.
  gpsActive: GpsActiveState;
  // #852: 마지막 신뢰 fix epoch ms. BG 진입 후 새 fix가 없으면 이 시각은 정지.
  // null = 한 번도 fix 없음(cold start). 디버그 모달 표기용.
  lastFixAtMs: number | null;
  // #2070 — fusion 결정 tier 품질 게이트(100m/15s) 저하 여부. 호출자(useFusedNearestStation)가
  // inferEnvironment의 추가 입력으로 사용 — 지하 진입 후보 신호이며, FG watch 폴링 프로파일도
  // 이 값으로 지하 프로파일 전환/원복된다.
  //
  // #2076 — true는 오직 게이트 통과 fix가 GPS_QUALITY_GATE_ABSENCE_MS(30s) 이상 없을 때만
  // (독립 타이머 구동, fix 도착 이벤트에 의존하지 않음 — 결함1). 급락(accuracy 1회성 급증) 단독으로는
  // true가 되지 않는다(결함2 — 지상 urban canyon 오탐 차단). false 복귀(해제)는 게이트 통과 fix가
  // 연속 2회 이상일 때만(hysteresis — 단발 fix 플랩 방지).
  gpsQualityDegraded: boolean;
  // #876: result 출처. sticky lock된 역이면 'sticky', live GPS 최근접이면 'live'.
  // 호출자가 출처별 UX(예: 라벨 "탑승 전 추정")로 분기 가능. 알람 트리거에는 영향 없음.
  source: NearestStationSource;
  refresh: () => Promise<void>;
  // #1317: 사용자가 지도탭 "현재위치"를 명시적으로 탭할 때 호출. sticky lock을 비우고 fresh
  // GPS fix를 요청해 live fused 위치를 노출한다. 일반 refresh(FG 복귀 등)는 sticky를 유지한다.
  requestCurrentLocation: () => Promise<void>;
}

// #711: BG task가 최근 평가한 nearest station. FG 복귀 직후 fresh fix 도착 전 임시 hydrate에 사용.
// WhileInUse 사용자는 BG task 미동작 → key 없음(null) → graceful no-op.
async function readBgLastStation(): Promise<NearestStationResult | null> {
  try {
    const raw = await AsyncStorage.getItem(BG_LAST_STATION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as { distanceKm?: unknown }).distanceKm === 'number' &&
      (parsed as { station?: unknown }).station &&
      typeof ((parsed as { station: { id?: unknown } }).station.id) === 'string'
    ) {
      const { station, distanceKm } = parsed as { station: Station; distanceKm: number };
      return { station, distanceKm };
    }
    return null;
  } catch {
    return null;
  }
}

function applyNearestResult(
  stationsResult: ReturnType<typeof findNearestStations>,
  setResult: (r: NearestStationResult | null) => void,
  setVariants: (v: Station[]) => void,
): void {
  if (stationsResult) {
    setResult({ station: stationsResult.primary, distanceKm: stationsResult.distanceKm });
    setVariants(stationsResult.variants);
  } else {
    setResult(null);
    setVariants([]);
  }
}

/**
 * #903 (Seam G) — 외부 신호 입력. 옵셔널이라 기존 호출자(테스트, 다른 화면)는 영향 없음.
 */
export interface UseNearestStationInputs {
  /**
   * 기압계(useBarometer) dP/dt가 지하 진입을 시사하는지. true면 useStickyStation의 automotive
   * 입력으로 전달되어 차/지하철 이동 확정 unlock 트리거. subsurface 신호는 OS 가속도계/GPS와
   * 무관하게 지상→지하 전이를 가장 일찍 감지하므로 sticky의 motion unlock 트리거로 사용한다.
   */
  barometerSubsurface?: boolean;
  /**
   * D6 (#1212) — trip(목적지/경로) 활성 여부. sticky 게이트에 전달되어 trip 활성 + 지하 조합에서
   * sticky unlock(motion/distance) 보류. 미전달이면 false로 간주(기존 동작 보존).
   */
  tripActive?: boolean;
}

export function useNearestStation(
  inputs: UseNearestStationInputs = {},
): UseNearestStationReturn {
  const [result, setResult] = useState<NearestStationResult | null>(null);
  const [variants, setVariants] = useState<Station[]>([]);
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [speedMps, setSpeedMps] = useState<number | null>(null);
  const [accuracyMeters, setAccuracyMeters] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [locationUncertain, setLocationUncertain] = useState(false);
  // #852: AppState 초기값 기준 — RN의 초기 currentState는 보통 'active'지만
  // 모듈 마운트 타이밍에 따라 'unknown'/'background'일 수 있어 wrapper로 통일.
  const [gpsActive, setGpsActive] = useState<GpsActiveState>(() => currentGpsActive());
  const [lastFixAtMs, setLastFixAtMs] = useState<number | null>(null);
  const subscriptionRef = useRef<Location.LocationSubscription | null>(null);
  // #1313 — "지하라 throttle 중인가"의 SSOT. startWatch가 호출 시점에 이 ref를 읽어 watch 옵션을
  // 고른다. subsurface 원시값이 아니라 throttle 여부(=== true)를 들고 있어 warmup(undefined)과
  // false가 동일 분기로 합쳐진다. inputs를 startWatch deps에 넣으면 identity가 매 render 흔들려
  // mount effect가 재실행되므로 ref로 분리한다(콜백 identity 안정 유지).
  // 초기값을 첫 render의 subsurface로 맞춰, 마운트 시 이미 지하면 startWatch가 곧장 throttle 옵션을
  // 고르고 restart effect는 변화 없음으로 early return → 마운트 중복 start 방지.
  const throttledRef = useRef(inputs.barometerSubsurface === true);
  const lastStationIdRef = useRef<string | null>(null);
  const lastDistanceRef = useRef<number>(0);
  // 진단용 누적 카운터: lastKnown 캐시 fix가 freshness/accuracy 게이트에서 거부된 횟수.
  // BG→FG 전환마다 startWatch가 호출되므로 stale 위치 의심 시 운영 로그로 추적한다.
  const lastKnownStaleCountRef = useRef<number>(0);
  const lastKnownLowAccuracyCountRef = useRef<number>(0);
  // #527: jump gate가 참조하는 직전 수용 fix. accuracy 게이트는 fix 단위 절대값만 보고
  // 이전 좌표와의 시공간 일관성은 확인하지 못한다 — 21:29 효창공원앞↔신내 25km/8s
  // 텔레포트 사고를 차단하기 위해 useRef로 prev를 들고 비교한다.
  const lastFixRef = useRef<FixSample | null>(null);
  // #1516: gps-drop 로그 폭주 dedup. 같은 accuracy/좌표 fix가 연속 push될 때 buffer + setState 폭주
  // (84+건/5분 → React reconcile 폭주, AsyncStorage write 부담). 직전 drop과 lat/lng/accuracy가
  // 모두 동일하면 skip한다. 진단성은 rate-limit summary로 보존(아래 lastDropWindowRef).
  const lastDropRef = useRef<{ lat: number; lng: number; acc: number | null } | null>(null);
  // #1516 + #1540 (S7): rate limit — sliding 1초 윈도우. 직전 push 시각 배열을 들고, 새 drop이
  // 들어올 때마다 1초보다 오래된 시각을 trim한 뒤 남은 개수가 GPS_DROP_PER_SEC_LIMIT 미만일 때만 push.
  //
  // 이전 구현(fixed window)은 `windowStart` 이후 1초가 경과하면 `count`/`skipped`를 reset하는 트랩이
  // 있었다 — drop이 1초보다 살짝 길게 spaced 도착하면 매번 윈도우가 reset되어 실효 한도가 ~2건/1.x초로
  // 풀려 cap 점령을 막지 못했다. 슬라이딩 윈도우는 직전 1초 동안의 실제 push 수만 본다.
  //
  // 작은 고정 ring buffer(limit + 1 슬롯)로 들고 있어 매 fix마다 GC 압박 없이 O(limit)로 trim.
  const lastDropWindowRef = useRef<{ timestamps: number[]; skipped: number }>({
    timestamps: [],
    skipped: 0,
  });
  // #2070 — fusion 결정 tier 품질 게이트(100m/15s) SSOT. 직전 게이트 통과 fix의 accuracy/시각을
  // ref로 들고 있다가 급락(>100m 진단용)/30s 부재 판정에 사용한다. gpsQualityDegraded는 폴링
  // 프로파일 전환 effect의 deps로 쓰여야 해서 state로 노출한다.
  const qualityGateLastPassAccuracyRef = useRef<number | null>(null);
  const qualityGateLastPassAtRef = useRef<number | null>(null);
  // #2076 — hysteresis 해제용 연속 게이트 통과 fix 카운터. 게이트 미달 fix(급락/부재 관계없이
  // 어떤 사유든)가 한 번이라도 끼면 0으로 리셋된다.
  const qualityGateConsecutivePassRef = useRef(0);
  const [gpsQualityDegraded, setGpsQualityDegraded] = useState(false);
  // #2100 — FG watch 프로파일(High/Balanced) 선택 전용 신호. 공개 gpsQualityDegraded(위)는
  // inferEnvironment(useFusedNearestStation)가 소비하므로 hysteresis(연속 2회 통과) 해제를 그대로
  // 유지한다 — 품질 게이트/fusion 판정 로직은 손대지 않는다(#2100 "하지 말 것"). 반면 지하에서
  // accuracy를 Balanced로 낮추면 Balanced fix는 100m/15s 게이트를 잘 통과하지 못해 hysteresis 2연속
  // 달성이 사실상 막혀 watch 프로파일이 영구 Balanced에 고착되는 악순환이 생긴다. profileWatchDegraded는
  // 진입(degrade)은 gpsQualityDegraded와 동일 신호(absence 30s)를 공유하되, 해제는 게이트 통과 fix
  // 단 1회만으로 즉시 반영(eager release)해 High로 선원복시킨 뒤 후속 fix로 실제 지상 복귀를 확인한다.
  const [profileWatchDegraded, setProfileWatchDegraded] = useState(false);

  // #2076 — 게이트 통과/미달 판정 자체는 applyLocation(표시 게이트 통과 fix)과 watch 콜백의
  // 표시 게이트 drop 분기(>250m fix) 양쪽에서 공유한다. 표시 상태(setUserLocation 등)는 절대
  // 건드리지 않고, 오직 품질 게이트 SSOT(ref/gpsQualityDegraded)만 갱신한다.
  //
  // degraded=true는 이 함수가 아니라 아래 absence 타이머(usePolling)가 단독으로 설정한다 — 급락
  // 단독으로 즉시 true가 되던 #2070 동작을 결함2로 판정해 제거했다. 이 함수는 게이트 통과 시
  // hysteresis 카운터를 올려 임계(2연속) 도달 시에만 false로 해제한다.
  const evaluateGpsQuality = useCallback(
    (
      accuracy: number | null | undefined,
      fixTimestamp: number,
      lat: number,
      lng: number,
      speed: number | null | undefined,
      // #2076 — 표시 게이트(250m)에서 이미 자체 dedup/rate-limit 로그(dropReason
      // 'low-accuracy-display')를 남기는 호출 경로(watch 콜백)는 중복 로그를 막기 위해 false로
      // 전달한다. 게이트 판정/hysteresis 카운터 갱신은 로그 여부와 무관하게 항상 수행된다.
      logDrop: boolean = true,
    ) => {
      const now = Date.now();
      const ageMs = now - fixTimestamp;
      if (isGpsQualityGateAcceptable(accuracy, ageMs)) {
        qualityGateLastPassAccuracyRef.current = accuracy;
        qualityGateLastPassAtRef.current = now;
        qualityGateConsecutivePassRef.current += 1;
        if (isGpsQualityHysteresisReleased(qualityGateConsecutivePassRef.current)) {
          setGpsQualityDegraded((prev) => (prev ? false : prev));
        }
        // #2100 — watch 프로파일 전용 eager release. 게이트 통과 fix가 단 1회만 등장해도 즉시
        // High로 선원복(위 gpsQualityDegraded의 2연속 hysteresis와 별개) — Balanced 지하 프로파일에서
        // hysteresis 2연속 달성이 막혀 원복 자체가 지연되는 악순환을 끊는다.
        setProfileWatchDegraded((prev) => (prev ? false : prev));
        return;
      }
      // #2076 결함2 — 급락 여부는 진단 로그에만 반영. degraded 상태를 직접 바꾸지 않는다.
      const jumpDegraded = isGpsQualityJumpDegraded(qualityGateLastPassAccuracyRef.current, accuracy);
      qualityGateConsecutivePassRef.current = 0;
      if (!logDrop) return;
      pushGpsDropEntry({
        ts: now,
        lat,
        lng,
        accuracyMeters: accuracy ?? null,
        speedMps: isValidGpsSpeedMps(speed) ? speed : null,
        dropReason: `gps-quality-drop:${gpsQualityDropReason(accuracy, ageMs)}${jumpDegraded ? '-jump' : ''}`,
      });
    },
    [],
  );

  // #2076 결함1 — absence 판정을 fix 도착 이벤트에서 분리한 독립 타이머. GPS가 완전히 유실되면
  // (심부 지하) fix 자체가 안 들어와 evaluateGpsQuality가 호출되지 않으므로, fix-driven 평가만으로는
  // absence 30s 판정이 영영 발동하지 못한다. 이 타이머가 마지막 게이트 통과 fix 시각을 주기적으로
  // 재평가해 fix 도착 여부와 무관하게 degraded=true를 설정한다. 해제는 여기서 하지 않는다(위
  // evaluateGpsQuality의 hysteresis 경로 전담) — 그래야 "판정 즉시 통과 fix로 해제" 같은 단발
  // flip이 재발하지 않는다.
  usePolling(() => {
    if (isGpsQualityAbsenceDegraded(qualityGateLastPassAtRef.current, Date.now())) {
      setGpsQualityDegraded((prev) => (prev ? prev : true));
      // #2100 — watch 프로파일 진입(degrade) 신호는 공개 gpsQualityDegraded와 동일 absence 판정을
      // 공유한다(품질 게이트 판정 로직 자체는 변경하지 않는다). 해제(release)만 위 evaluateGpsQuality의
      // eager 경로로 분리된다.
      setProfileWatchDegraded((prev) => (prev ? prev : true));
    }
  }, GPS_QUALITY_GATE_TIMER_INTERVAL_MS);

  const applyLocation = useCallback((coords: Location.LocationObjectCoords, timestamp: number) => {
    const { latitude, longitude, speed, accuracy } = coords;
    const fix: FixSample = { lat: latitude, lng: longitude, timestamp };
    if (!isPlausibleJump(lastFixRef.current, fix)) {
      setLocationUncertain(true);
      return;
    }
    lastFixRef.current = fix;
    // jump/accuracy 게이트 모두 통과한 신뢰 fix — uncertain 상태에서 자동 복귀시킨다.
    // (호출자 측 setLocationUncertain(false)에 의존하면 jump drop 직후 정상 fix가 들어와도
    //  복귀 호출 경로가 없어 uncertain이 고착되는 결함 발생 — P1 회피.)
    setLocationUncertain(false);
    // #852: 신뢰 fix가 채택된 시점을 기록 — 디버그 모달 GPS 섹션에서 stale window 시각화.
    // jump/accuracy drop된 fix는 채택 안 함(stale 시각이 그대로 유지) — 사용자가 stale 구간 식별 가능.
    setLastFixAtMs(timestamp);
    const stationsResult = findNearestStations(latitude, longitude, MAX_STATION_DISTANCE_KM);

    const newId = stationsResult?.primary.id ?? null;
    const newDistance = stationsResult?.distanceKm ?? 0;
    const stationChanged = newId !== lastStationIdRef.current;
    const distanceDelta = Math.abs(newDistance - lastDistanceRef.current);
    const noStation = !stationsResult && lastStationIdRef.current !== null;

    // raw 신호는 매 fix 즉시 갱신. useFusedNearestStation의 candidates 메모가
    // userLocation 변화에 의존하므로 throttle 안에 두면 천천히 이동할 때 후보가 잠긴다.
    setSpeedMps(isValidGpsSpeedMps(speed) ? speed : null);
    setAccuracyMeters(accuracy ?? null);
    setUserLocation({ lat: latitude, lng: longitude });

    // 표시값(result/variants)은 3m throttle 유지 — 잦은 리렌더 방지.
    if (stationChanged || distanceDelta > MIN_DISTANCE_CHANGE_KM || noStation) {
      lastStationIdRef.current = newId;
      lastDistanceRef.current = newDistance;
      applyNearestResult(stationsResult, setResult, setVariants);
    }
    // #2070 — fusion 결정 tier 품질 게이트. 기존 표시 게이트(MAX_ACCURACY_M_DISPLAY=250m)는
    // 통과했지만 결정 tier 입력 기준(100m/15s)에는 못 미치는 fix를 판별한다. userLocation/
    // accuracyMeters/result 자체는 그대로 노출(표시 동작 불변) — 결정 tier 소비자
    // (useFusedNearestStation)가 gpsQualityDegraded를 별도로 참고해 판단한다.
    // #2076 — 판정 로직은 evaluateGpsQuality로 추출(표시 게이트 drop 분기와 공유).
    evaluateGpsQuality(accuracy, timestamp, latitude, longitude, speed);

    // 측정(#443): station 변화 시에만 push. 매 fix는 너무 자주 — 점프 시퀀스
    // (사가정→을지로4가→용마산) 재구성엔 station 단위면 충분.
    if (stationChanged || noStation) {
      pushFusionDebugEntry({
        kind: 'gps',
        event: 'gps-fix',
        ts: Date.now(),
        lat: latitude,
        lng: longitude,
        accuracyMeters: accuracy ?? null,
        speedMps: isValidGpsSpeedMps(speed) ? speed : null,
        nearestStation: stationsResult?.primary.name ?? null,
        nearestLine: stationsResult?.primary.line ?? null,
        nearestDistanceKm: stationsResult?.distanceKm ?? null,
      });
    }
  }, [evaluateGpsQuality]);

  const stopWatch = useCallback(() => {
    subscriptionRef.current?.remove();
    subscriptionRef.current = null;
  }, []);

  const startWatch = useCallback(async () => {
    subscriptionRef.current?.remove();
    subscriptionRef.current = null;
    if (IS_E2E_MOCK) {
      setError(null);
      setPermissionDenied(false);
      setLocationUncertain(false);
      applyLocation(
        {
          latitude: E2E_MOCK_LOCATION.latitude,
          longitude: E2E_MOCK_LOCATION.longitude,
          accuracy: E2E_MOCK_LOCATION.accuracyMeters,
          speed: E2E_MOCK_LOCATION.speedMps,
          altitude: null,
          altitudeAccuracy: null,
          heading: null,
        },
        Date.now(),
      );
      setLoading(false);
      return;
    }
    try {
      setError(null);
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        setPermissionDenied(true);
        setLoading(false);
        return;
      }
      setPermissionDenied(false);

      // #808: 캐시 위치 hydrate 정책 — cold start 빈 화면 회피 + 잘못된 라우팅 방지.
      //
      // freshness 게이트(MAX_LOCATION_AGE_MS=15s)는 항상 유지 — stale 좌표로 hydrate하면
      // 사용자가 이미 이동한 뒤일 수 있어 위험.
      //
      // accuracy 게이트는 **표시 게이트(MAX_ACCURACY_M_DISPLAY=250m)**까지 허용:
      //   - 알람 엄격(200m) 통과 → applyLocation 정상 경로 (uncertain=false)
      //   - 알람 엄격 초과 + 표시 통과 (200~250m) → result만 hydrate + uncertain=true
      //     (cold start 빈 화면 회피 — UI는 "위치 확인 중" + 추정 역 표시)
      //   - 표시 게이트 초과 → 진단 로그 + 무시 (오정보 방지)
      // watch가 fresh fix를 보내면 uncertain이 false로 복귀하며 정정 가능.
      // 사용자 정책 "실시간성 우선, 나쁜 좌표 거부"와 일치 — 250m도 거부, 그 이하만 hydrate.
      //
      // #1925 — maxAge 명시. 무인자 호출은 expo-location 내부 기본값이
      // `.greatestFiniteMagnitude`라 OS가 1h+ stale cached fix를 그대로 반환할 수 있어
      // (LastKnownLocationRequirements.swift:6), JS 게이트는 통과하지만 timestamp 자체가
      // 1h 전인 fix가 hydrate되는 회귀를 만든다. OS-level + JS-level 두 게이트로 defense-in-depth.
      const lastKnown = await Location.getLastKnownPositionAsync({
        maxAge: MAX_LOCATION_AGE_MS,
      });
      if (lastKnown) {
        const fresh = isLocationFresh(lastKnown.timestamp);
        const strictlyAcceptable = isAccuracyAcceptable(lastKnown.coords.accuracy);
        const displayAcceptable = isAccuracyAcceptableForDisplay(lastKnown.coords.accuracy);
        if (fresh && strictlyAcceptable) {
          applyLocation(lastKnown.coords, lastKnown.timestamp);
          setLoading(false);
        } else if (fresh && displayAcceptable) {
          // cold start 완화 hydrate — result는 채우되 uncertain=true로 신뢰도 표시.
          applyLocation(lastKnown.coords, lastKnown.timestamp);
          setLocationUncertain(true);
          setLoading(false);
          logger.info('lastKnown coldStart hydrate: uncertain', {
            accuracyMeters: lastKnown.coords.accuracy,
          });
        } else if (!fresh) {
          lastKnownStaleCountRef.current += 1;
          logger.info('lastKnown rejected: stale', {
            ageMs: Date.now() - lastKnown.timestamp,
            cumulativeStale: lastKnownStaleCountRef.current,
          });
        } else {
          lastKnownLowAccuracyCountRef.current += 1;
          logger.info('lastKnown rejected: lowAccuracy', {
            accuracyMeters: lastKnown.coords.accuracy,
            cumulativeLowAccuracy: lastKnownLowAccuracyCountRef.current,
          });
        }
      }

      // 연속 GPS 스트리밍 — 지하 구간 horizontalAccuracy(300~1500m)도 표시용으로는 수용.
      // 알람은 useStationAlarm에서 accuracyMeters로 별도 엄격 게이트.
      // 지상(기본): High + distanceInterval:0 + timeInterval:2000:
      //  좌표를 최대한 자주 흘려보낸다 (foreground 한정, 화면 켜진 동안만).
      //  High는 GPS hardware fix가 없으면 WiFi BSSID / Cell tower triangulation으로 fallback
      //  → 지하 구간에서도 ~50~100m 위치가 들어옴 (BestForNavigation은 fallback 없이 stale).
      // 지하(subsurface 확정, #1313 + #2100): Balanced + timeInterval:12000으로 throttle.
      //  #1983 이후 한동안 High를 썼으나(지하 fix 정확도 확보 목적), #2074 품질 게이트가 지하 fix를
      //  전량 폐기하는 게 실측 확인돼(7/7 gps-drop 84건) Balanced로 재전환 — 지하 무의미 GPS
      //  삼각측량 재시도(발열 주범)를 낮춘다. 지상 복귀는 GPS 게이트 hysteresis에만 기대지 않고
      //  profileWatchDegraded eager release + barometerSubsurface 즉시 원복으로 보강(아래 참고).
      //  throttledRef가 현재 throttle 여부를 들고 있어 flip 시 effect가
      //  stopWatch→startWatch로 재구성한다(아래 useEffect).
      // 참고: pausesUpdatesAutomatically / activityType은 expo-location foreground 옵션에
      //  노출되지 않아 적용 불가. background task 옵션에서만 사용 가능.
      subscriptionRef.current = await Location.watchPositionAsync(
        fgWatchOptionsFor(throttledRef.current),
        (location) => {
          if (!isAccuracyAcceptableForDisplay(location.coords.accuracy)) {
            // #1516: setLocationUncertain(true)도 이전 값과 같으면 setState skip.
            // React 자동 bail-out은 hook 단위만 — 84+회/5분 reentry 시 useState reducer 호출
            // 자체가 reconcile 큐에 들어가는 부담을 명시 가드로 제거한다.
            setLocationUncertain((prev) => (prev ? prev : true));
            // #2076 결함1 — 표시 게이트(250m)에서 drop되는 fix도 품질 게이트(100m/15s) 평가에는
            // 반드시 공급한다. 표시 경로(setUserLocation/setResult 등)는 건드리지 않고 품질 게이트
            // SSOT(ref/hysteresis 카운터/gps-drop 로그)만 갱신 — 심부 지하처럼 fix가 계속 >250m로만
            // 들어오는 구간에서도 hysteresis 카운터가 정확히 리셋되고 진단 로그가 남는다.
            evaluateGpsQuality(
              location.coords.accuracy,
              location.timestamp,
              location.coords.latitude,
              location.coords.longitude,
              location.coords.speed,
              false,
            );
            // #443: 표시 게이트에 drop된 fix도 사후 진단에 필요(사가정 같은 부정확 fix로
            // 락된 의심 시점을 식별). 이 분기는 accuracy가 non-null 임계 초과인 경우만.
            const dropSpeed = location.coords.speed;
            const lat = location.coords.latitude;
            const lng = location.coords.longitude;
            const acc = location.coords.accuracy;
            // #1516 dedup gate 1: 직전 drop과 lat/lng/accuracy 모두 동일하면 skip.
            // 실측: 동일 accuracy(1414m) × 18건 다발 — same OS fix가 재발화하는 패턴.
            const prevDrop = lastDropRef.current;
            const sameAsPrev =
              prevDrop !== null &&
              prevDrop.lat === lat &&
              prevDrop.lng === lng &&
              prevDrop.acc === acc;
            if (sameAsPrev) return;
            // #1516 + #1540 (S7) dedup gate 2: 슬라이딩 1초 윈도우 rate limit.
            // 직전 1초보다 오래된 timestamp를 trim한 뒤 남은 push 수가 limit 미만이면 push.
            // limit 도달 시 skipped 누적 — 다음 push 시점에 summary 1건으로 흡수해 drop 가시성 보존.
            // #1540: gps-drop entry는 fusionDebugBuffer가 아니라 gpsDropBuffer로 분리해
            // fire-related entry(fusion decision / sticky / gps-fix)가 점령되지 않게 한다.
            const now = Date.now();
            const win = lastDropWindowRef.current;
            const cutoff = now - GPS_DROP_WINDOW_MS;
            // 슬라이딩 윈도우 trim — 가장 오래된 entry부터 cutoff 이전이면 제거.
            while (win.timestamps.length > 0 && win.timestamps[0] <= cutoff) {
              win.timestamps.shift();
            }
            if (win.timestamps.length >= GPS_DROP_PER_SEC_LIMIT) {
              win.skipped += 1;
              return;
            }
            // 윈도우 capacity 여유 있음 → push. 직전 skipped > 0이면 summary 1건 먼저 push.
            if (win.skipped > 0) {
              pushGpsDropEntry({
                ts: now,
                lat,
                lng,
                accuracyMeters: acc,
                speedMps: isValidGpsSpeedMps(dropSpeed) ? dropSpeed : null,
                dropReason: `rate-limited:${win.skipped}`,
              });
              // summary도 rate에 포함시켜 limit 내에 머무르게 한다.
              win.timestamps.push(now);
              win.skipped = 0;
              if (win.timestamps.length >= GPS_DROP_PER_SEC_LIMIT) {
                // summary로 limit 소진 — 본 drop은 다음 윈도우로 미룬다.
                win.skipped = 1;
                return;
              }
            }
            win.timestamps.push(now);
            lastDropRef.current = { lat, lng, acc };
            pushGpsDropEntry({
              ts: now,
              lat,
              lng,
              accuracyMeters: acc,
              speedMps: isValidGpsSpeedMps(dropSpeed) ? dropSpeed : null,
              dropReason: 'low-accuracy-display',
            });
            return;
          }
          setLocationUncertain(false);
          applyLocation(location.coords, location.timestamp);
        },
      );
      setLoading(false);
    } catch {
      setError('위치를 가져오는 데 실패했습니다.');
      setLoading(false);
    }
  }, [applyLocation, evaluateGpsQuality]);

  // 수동 새로고침: watch 중지 → one-shot → watch 재시작
  const refresh = useCallback(async () => {
    stopWatch();
    if (IS_E2E_MOCK) {
      await startWatch();
      return;
    }
    let shouldRestart = true;
    try {
      setError(null);
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        setPermissionDenied(true);
        shouldRestart = false;
        return;
      }
      setPermissionDenied(false);
      const location = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      if (isAccuracyAcceptableForDisplay(location.coords.accuracy)) {
        setLocationUncertain(false);
        applyLocation(location.coords, location.timestamp);
      } else {
        setLocationUncertain(true);
      }
    } catch {
      setError('위치를 가져오는 데 실패했습니다.');
    } finally {
      if (shouldRestart) await startWatch();
    }
  }, [stopWatch, startWatch, applyLocation]);

  useEffect(() => {
    startWatch();

    const appStateSub = AppState.addEventListener('change', (state) => {
      // #852: AppState 전환 시점에 즉시 gpsActive 라벨 갱신. silent push wake로 BG에 있는 동안
      // 'bg' 상태 유지 → 사용자가 디버그 모달에서 확인 가능.
      setGpsActive(appStateToGpsActive(state));
      if (state === 'active') {
        // FG 복귀 시 result는 BG 진입 시점의 stale 위치 — 사용자가 그 사이 이동했을 수 있다 (#543).
        // 명시적으로 uncertain 상태로 전환해 UI가 "위치 확인 중"을 표시하게 하고,
        // refresh()로 즉시 fresh fix를 요청한다. fresh fix가 들어오면 applyLocation이 uncertain을 해제.
        setLocationUncertain(true);
        // #711: BG task가 최근 평가한 nearest를 임시 hydrate. fresh fix(refresh→applyLocation) 도착 전
        // UI 공백을 메운다. uncertain=true는 유지 → "위치 확인 중" 표시 + hydrate된 역 정보 노출.
        // race: hydrate가 applyLocation 후에 resolve되면 신선 fix를 덮어쓸 수 있어,
        // result가 비어있을 때만 채운다 (prev ?? bg).
        // WhileInUse 사용자는 key 부재 → readBgLastStation null → no-op.
        void readBgLastStation().then((bg) => {
          if (bg) {
            setResult((prev) => prev ?? bg);
          }
        });
        void refresh();
      } else if (state === 'background') {
        stopWatch();
      }
      // inactive는 일시적 상태(전화 착신 등)이므로 무시
    });

    return () => {
      stopWatch();
      appStateSub.remove();
    };
  }, [startWatch, stopWatch, refresh]);

  // #1313 — subsurface(지하) 확정 여부가 뒤집히면 FG watch를 재구성한다. expo-location FG 옵션은
  // 라이브 변경이 불가해 stopWatch→startWatch로 재시작한다(startWatch가 throttledRef를 읽어 새 옵션 채택).
  // 3가지 가드:
  //  - throttle boolean이 실제로 바뀐 경우만 동작 → mount 시 중복 start 방지 + warmup(undefined)→false no-op.
  //  - AppState 'active'일 때만 재시작 → BG 중 flip이 FG watch를 켜 'background'→stopWatch 규약을 깨는 것 방지.
  //    (FG 복귀 시 'active' 핸들러의 refresh→startWatch가 ref를 읽어 현재 옵션으로 자연 반영.)
  //
  // #2070 — 지하 프로파일 트리거를 barometerSubsurface OR profileWatchDegraded로 확장. 기존
  // FG_WATCH_OPTIONS_SUBSURFACE를 그대로 재사용한다(barometer 확정 지하와 배터리 절감 목적이
  // 동일 — 신규 profile 값을 중복 정의하지 않는다).
  // #2100 — gpsQualityDegraded(hysteresis 2연속 해제, inferEnvironment 공용 SSOT) 대신
  // profileWatchDegraded(eager 1회 해제)를 사용한다 — accuracy가 Balanced로 낮아진 지하에서는
  // hysteresis 2연속 통과 fix 확보 자체가 어려워 원복이 지연/고착되는 것을 막기 위함(#2100 "선원복
  // 후 fix 대기"). barometerSubsurface가 명시 지상(false)으로 바뀌는 것도 동일하게 즉시 반영된다
  // (기존부터 hysteresis 없이 즉시 OR 입력).
  // 재시작 skip 가드(next === throttledRef.current)는 #2080에서 도입된 churn 방지 로직을 그대로
  // 재사용 — 동일 프로파일로 판정되면 stopWatch/startWatch를 호출하지 않는다.
  //
  // #2100 스펙 이탈 명시 — 이슈는 지상 복귀 트리거 3종(barometer surface 판정 / environment 전환 /
  // 게이트 통과 fix 재등장)을 명시했으나, 이 훅은 inferEnvironment.ts의 Environment 라벨을 입력으로
  // 받지 않는다(useFusedNearestStation이 gps.gpsQualityDegraded를 inferEnvironment에 넘겨 라벨을
  // 산출하는 순서라 여기서 라벨을 역참조하면 순환 의존이 생긴다 — 이슈가 명시적으로 inferEnvironment.ts
  // 접촉을 금지한 이유이기도 하다). 따라서 "environment 전환" 트리거는 이 훅이 이미 들고 있는 두
  // 로컬 proxy로 대체했다: barometerSubsurface(명시 지상 판정)와 profileWatchDegraded(게이트 통과
  // fix 재등장, eager). inferEnvironment의 라벨 산출 자체가 이 두 신호(+ SSOT)로 구성되므로 실질적
  // 커버리지 손실은 없다고 판단했다.
  // 잔여 케이스: barometer가 warmup/미지원(subsurface===undefined)이고 SSOT도 무판정인 채로
  // backend position-SSOT만으로 지상 복귀가 먼저 확정되는 경우, 이 훅은 그 사실을 알 방법이 없어
  // watch 프로파일이 즉시 반응하지 않는다 — 다만 이 경로도 지상에 실제로 진입하면 곧 High-등급
  // GPS fix가 표시 게이트(250m)를 통과하게 되므로, profileWatchDegraded의 게이트 통과 fix
  // eager-release로 짧은 지연 후 self-heal된다(별도 트리거 불필요).
  useEffect(() => {
    const next = inputs.barometerSubsurface === true || profileWatchDegraded;
    if (next === throttledRef.current) return;
    throttledRef.current = next;
    if (AppState.currentState !== 'active') return;
    stopWatch();
    void startWatch();
  }, [inputs.barometerSubsurface, profileWatchDegraded, startWatch, stopWatch]);

  // #876 — 매 fix를 sticky 훅에 전달. lock된 역이 있으면 result를 그것으로 override.
  // fusion candidates는 useFusedNearestStation에서 userLocation 기반으로 별도 계산하므로 영향 없음.
  //
  // #903 (Seam G) — 기압계 subsurface 신호를 sticky의 automotive 입력으로 매핑.
  // 지하 진입은 차/지하철 이동 확정과 동등한 unlock 트리거(사용자가 이미 지상 sticky를 떠나 이동 중).
  // CMMotionActivity native bridge가 자동차 신호를 노출하지 않아 sticky가 motion unlock 미작동
  // 상태였던 회귀 해소.
  // #1363 — sticky cascade emit 16만회 회귀 차단.
  // useStickyStation 호출에 inline object literal을 그대로 넘기면 매 render마다 새 reference가
  // 생성돼 effect deps([fix, motion, ...])가 매번 변경된 것으로 평가된다. 9시간 trip에서 약
  // ~16만회 effect 재실행 → emit/AsyncStorage write/log churn. candidate identity(station.id)와
  // 측정 가능한 숫자 신호로만 memo 키를 잡아 effect를 안정화한다.
  const stickyFix = useMemo(
    () => ({ candidate: result, accuracyMeters, speedMps }),
    [result, accuracyMeters, speedMps],
  );
  const stickyMotion = useMemo(
    () => ({
      automotive: inputs.barometerSubsurface === true,
      // D6 (#1212) — subsurface + tripActive를 sticky 게이트에 직접 전달.
      // automotive=subsurface 매핑은 유지하되, 지하 + trip 활성 조합에서는 unlock 보류.
      subsurface: inputs.barometerSubsurface === true,
      tripActive: inputs.tripActive === true,
    }),
    [inputs.barometerSubsurface, inputs.tripActive],
  );
  const sticky = useStickyStation(stickyFix, stickyMotion);

  // #1317 — 지도탭 "현재위치" 명시 탭 경로. sticky lock을 즉시 비운 뒤 fresh GPS fix를 요청해
  // live fused 위치를 노출한다. refresh()만으로는 sticky override가 남아 현재역이 lock된 역
  // (예: 출발역 용마산)으로 회귀하므로, sticky 해제를 함께 수행한다. FG 복귀 시의 일반 refresh는
  // sticky를 유지해야 하므로(D6 — 탑승 중 노선 정보 보존) 이 경로를 별도로 분리한다.
  const { releaseLock } = sticky;
  const requestCurrentLocation = useCallback(async () => {
    releaseLock();
    await refresh();
  }, [releaseLock, refresh]);

  const exposed = useMemo<{ result: NearestStationResult | null; source: NearestStationSource }>(
    () => {
      // sticky 비활성 또는 sticky가 live와 같은 역이면 live 결과 그대로 — reference 유지로
      // throttle/리렌더 가정을 깨지 않는다. sticky가 다른 역을 lock한 경우에만 override.
      if (!sticky.locked) return { result, source: 'live' };
      if (result && result.station.id === sticky.locked.id) {
        return { result, source: 'sticky' };
      }
      const distanceKm = userLocation
        ? haversine(userLocation.lat, userLocation.lng, sticky.locked.lat, sticky.locked.lng)
        : 0;
      return {
        result: { station: sticky.locked, distanceKm },
        source: 'sticky',
      };
    },
    [sticky.locked, result, userLocation],
  );

  return {
    result: exposed.result,
    // #1486 (ADR-015 §2) — sticky override 없는 live GPS 결과. useFusedNearestStation cascade가
    // fire path 입력으로 사용 (sticky 격리). sticky 비활성 또는 같은 역이면 exposed.result와
    // 동일 reference (위 useMemo 분기 0의 `result` 그대로) — 추가 cost 없음.
    liveResult: result,
    // #1486 (ADR-015 §2) — sticky lock 정보 표시 전용 채널.
    // 호출자(useFusedNearestStation)가 DebugModal/UI 추적용으로 그대로 통과시킨다.
    stickyDisplayOnly: sticky.locked,
    variants,
    userLocation,
    speedMps,
    accuracyMeters,
    loading,
    error,
    permissionDenied,
    locationUncertain,
    gpsActive,
    lastFixAtMs,
    gpsQualityDegraded,
    source: exposed.source,
    refresh,
    requestCurrentLocation,
  };
}
