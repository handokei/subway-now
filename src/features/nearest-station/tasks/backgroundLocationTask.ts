/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: 이 파일은 의도적으로 여러 features의 hook/util을 조합하는
 * orchestrator 역할이라 직접 import가 본질적이다. Phase 5 enforce 모드에서 file-level disable로
 * 옵트인 처리. 후속 PR(별도 이슈)에서 orchestration 슬라이스(예: features/fusion/, app shell)로
 * 추출하여 disable을 제거할 예정.
 *
 * ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" Phase 5 (#890).
 */
import * as TaskManager from 'expo-task-manager';
import * as Location from 'expo-location';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { processLocationUpdate } from '../../alarm/utils/stationPipeline';
import { alarmKey } from '../../alarm/utils/stationAlarm';
import { createLogger } from '../../../shared/utils/logger';
import { APNS_TOKEN_KEY, DESTINATION_KEY, SLEEP_MODE_KEY, ALARM_EVENT_KEY, ROUTE_KEY } from '../../../shared/constants/storageKeys';
import { getFiredAlarms, setFiredAlarms } from '../../alarm/utils/notificationState';
import { isAccuracyAcceptable, isLocationFresh, isPlausibleJump, type FixSample } from '../utils/locationGates';
import { logSuppressedGate, logBgTaskHeartbeat } from '../../alarm/utils/alarmLog';
import { BG_LAST_FIX_KEY, BG_LAST_STATION_KEY, BG_LAST_POSITION_UPLOAD_AT_KEY } from '../../../shared/constants/storageKeys';
import { uploadPosition, type PositionMotion } from '../api/positionUpload';
import { POSITION_UPLOAD_MIN_INTERVAL_MS } from '../../../shared/constants/location';
import { getCurrentMotionStationary } from '../utils/motionActivity';
import {
  applyBgLocationProfile,
  demoteToUndergroundIfNeeded,
  releaseFromUndergroundIfNeeded,
} from '../utils/bgLocationProfile';
import { getLatestAccelSummary } from '../utils/accelMotionState';
// #1542 (ADR-016 S9) — CMMotionManager accelerometer fingerprint (Background Location piggyback).
// BG location updates 활성 동안 raw 가속도 5Hz sampling 시작 — 정적 native module (no-op if already
// started). position upload 시점에 latest 60s window snapshot을 첨부해 backend가 진동 fingerprint
// 환경 vote로 사용 + undergroundSSotConsensus가 'automotive' pattern을 1표로 채택.
import {
  startAccelerometerFingerprint,
  getLatestAccelerometerSnapshot,
  classifyAccelerometerPattern,
} from '../utils/accelerometerFingerprint';
import { evaluateMovement } from '../utils/movementGate';
// #1237 — BG tick에서도 위젯 SSOT(App Groups UserDefaults)를 갱신해 FG 진입 전까지 stale로 남지 않게 한다.
// cross-feature import는 파일 헤더의 file-level eslint-disable로 옵트인 (orchestrator 본질).
import { saveStationToWidget } from '../../widget/api/widgetStorage';
import { buildWidgetTripContext } from '../../widget/utils/buildTripContext';
import type { Route } from '../../../shared/utils/stationRoute';
import { isValidGpsSpeedMps } from '../../../shared/constants/location';
import type { Station } from '../../../shared/types/station';
// #1667 (ADR-015 strongDB wire) — WiFi SSID 매핑 역명 backend forward.
// device가 lookup 후 역명만 송신 — backend는 stations.json 없으므로 lookup은 device 책임.
import { getCurrentWifiSsid } from '../utils/wifiSsidNative';
import { lookupStationBySsid } from '../utils/wifiSsidLookup';
// #2178 — pull 기반 trip 死 backstop. 신규 폴링/타이머 없이 이미 깨어나는 BG location tick에
// 편승해 저빈도(내부 쿨다운)로 backend trip status를 확인한다. alarm 슬라이스 cross-feature
// import는 본 파일 헤더 file-level disable로 이미 옵트인.
import { checkTripDeathByPull, getBackendUrl as getTripDeathPullBackendUrl } from '../../alarm/utils/tripDeathPullBackstop';
// #2381 (Gap A+B) — 지하(GPS dead) BG 자가감지. gate-accuracy 연속 실패로 'underground'
// profile 강등 + lock 존재 tick에서 arvlCd+accel+cellular consensus로 device가 스스로 판정·발사.
import { isMinimalAlarmEnabled } from '../../../shared/constants/debugFlags';
import { evaluateUndergroundConsensusFire } from '../../alarm/utils/undergroundConsensusFire';
// #2383 (Part of #2381) — position-train-lock BG 발사 경로. 환경(지상/지하) 오분류·GPS accuracy
// 상태에 독립적으로 lock.trainCode를 arvlCd로 직접 추적한다 (#2382 WiFi/consensus 경로보다 우선).
import { evaluatePositionTrainFire } from '../../alarm/utils/bgPositionTrainFire';

const logger = createLogger('BackgroundLocation');

export const BACKGROUND_LOCATION_TASK = 'background-location-task';

/**
 * #823 — accelSummary 첨부 가능한 최대 stale age. WINDOW_FLUSH_MS(1s)의 5배 cushion으로
 * FG가 짧게 꺼졌다 다시 켜지는 경우는 허용하면서, 분 단위로 오래된 stale은 차단한다.
 */
export const ACCEL_SUMMARY_MAX_AGE_MS = 5_000;

/**
 * #1542 (ADR-016 S9) — accelerometer fingerprint pattern + CMMotionActivity stationary 신호 결합.
 *
 * 정책:
 *   - accelerometer 'stationary' / 'walking' / 'automotive' → 그대로 PositionMotion 라벨 채택
 *   - accelerometer 'unknown' (60s window 미수렴 / 미지원) → CMMotionActivity fallback
 *       - motionActivity.stationary=true → 'stationary'
 *       - 그 외 → 'unknown' (기존 #819 정책)
 *
 * 우선순위 이유: 60s window RMS magnitude는 CMMotionActivity의 5~10분 intermittent flip 문제
 * (lesson_motion_activity_intermittent_signal)를 piggyback BG 실측으로 mitigation한다. 단,
 * 60s window 미수렴 시(0-60s 첫 cycle) fallback이 안전.
 *
 * pure function — 별 파일 분리 없이 backgroundLocationTask scope 내부 helper.
 */
export function pickMotionLabel(
  accelPattern: 'stationary' | 'walking' | 'automotive' | 'unknown',
  motionStationary: boolean,
): PositionMotion {
  if (accelPattern !== 'unknown') return accelPattern;
  return motionStationary ? 'stationary' : 'unknown';
}

/**
 * #2093 (A) — 마지막 POST /position 발사 시각(epoch ms) 조회. 파싱 실패/키 부재는 null(첫 fix
 * 취급 → 즉시 발사). TaskManager invocation마다 새 컨텍스트라 in-memory ref 대신 AsyncStorage로
 * invocation 간 상태를 공유한다.
 */
async function readBgLastPositionUploadAt(): Promise<number | null> {
  try {
    const raw = await AsyncStorage.getItem(BG_LAST_POSITION_UPLOAD_AT_KEY);
    if (!raw) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function readBgLastFix(): Promise<FixSample | null> {
  try {
    const raw = await AsyncStorage.getItem(BG_LAST_FIX_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as FixSample).lat === 'number' &&
      typeof (parsed as FixSample).lng === 'number' &&
      typeof (parsed as FixSample).timestamp === 'number'
    ) {
      return parsed as FixSample;
    }
    return null;
  } catch {
    return null;
  }
}

TaskManager.defineTask(BACKGROUND_LOCATION_TASK, async ({ data, error }) => {
  if (error) {
    logger.error('백그라운드 위치 오류:', error.message);
    return;
  }
  if (!data) return;

  const { locations } = data as { locations: Location.LocationObject[] };
  const latest = locations[locations.length - 1];
  if (!latest) return;

  // #2403 — BG task 발화 heartbeat. behavior 무변경 순수 진단 계측: 이 tick이 실제로 깨어났다는
  // 사실 자체와 fix staleness(ageMs)/accuracy를 덤프에 남겨 지하 발화 간격 측정을 가능하게 한다.
  // 아래 gate/position-train/consensus 발사 로직보다 먼저 fire-and-forget으로 적재 — 그 경로가
  // 조기 return하거나 fire해도 이 heartbeat는 항상 남는다.
  logBgTaskHeartbeat({
    lat: latest.coords.latitude,
    lng: latest.coords.longitude,
    accuracy: latest.coords.accuracy,
    ageMs: Date.now() - (latest.timestamp ?? 0),
  });

  // #2178 — pull 기반 trip 死 backstop. GPS fix 품질(age/accuracy)과 무관하게 "BG task가
  // 깨어났다"는 사실 자체가 backend 생존 확인 기회다. fire-and-forget — 아래 알람 파이프라인의
  // 타이밍을 막지 않는다. 내부 쿨다운(TRIP_DEATH_PULL_BACKSTOP_THRESHOLD_MS)이 매 tick마다
  // backend를 호출하지 않도록 빈도를 제한하고, baseUrl 미설정/active trip 없음/네트워크 실패는
  // checkTripDeathByPull 내부에서 graceful skip.
  const tripDeathPullBackendUrl = getTripDeathPullBackendUrl();
  if (tripDeathPullBackendUrl !== null) {
    void checkTripDeathByPull(tripDeathPullBackendUrl, 'bg-location-tick').catch((e: unknown) => {
      logger.warn('pull death backstop 실패 (graceful)', e);
    });
  }

  // #2383 (Part of #2381) — position-train-lock 경로. lock 활성(trainCode 존재)이면 GPS
  // accuracy 상태와 무관하게(환경/GPS/WiFi 독립이 핵심) arvlCd로 그 trainCode 열차의 현재
  // 역을 직접 판정해 발사를 먼저 시도한다. 2026-08-26 덤프: GPS accuracy가 9~40m로 "정상"
  // 판정돼 아래 gate-accuracy 강등 분기(→ #2382 evaluateUndergroundConsensusFire)에 도달조차
  // 못 한 채 지하에서 위치가 틀린 채 방치됐다 — 그 실패 지점을 우회하는 것이 이 경로의 목적.
  // 채택 성공(true) 시 이번 tick은 이미 처리되었으므로 GPS 파이프라인으로 fall through하지 않는다.
  if (isMinimalAlarmEnabled()) {
    try {
      const fired = await evaluatePositionTrainFire();
      if (fired) return;
    } catch (e) {
      logger.warn('position-train lock 처리 실패 (graceful)', e);
    }
  }

  // iOS deferred 위치 배치에서 stale/저정확도 좌표가 섞여 들어올 수 있음 — 차단.
  // 측정용으로 게이트 drop을 알람 로그에 fire-and-forget 적재 (B2 인프라).
  const { latitude: lat, longitude: lng, accuracy } = latest.coords;
  const ageMs = Date.now() - (latest.timestamp ?? 0);
  if (!isLocationFresh(latest.timestamp)) {
    logSuppressedGate('gate-age', { lat, lng, accuracy, ageMs });
    return;
  }
  // BG task는 알람 발화 경로이므로 알람 엄격 게이트(MAX_ACCURACY_M=200m)를 유지한다.
  // foreground watch의 표시용 완화 게이트(MAX_ACCURACY_M_DISPLAY=1500m)는 여기서 적용 금지.
  // 여기서 게이트를 풀면 지하 구간 노이즈 좌표로 알람이 잘못 발화될 수 있다.
  if (!isAccuracyAcceptable(accuracy)) {
    logSuppressedGate('gate-accuracy', { lat, lng, accuracy, ageMs });
    // #2345 — 지하 accuracy 강등 proxy. 기압계는 BG에서 무용(FG-only)이라, 연속 gate-accuracy
    // 실패를 지하 진입 신호로 사용한다. early-return 이전에 카운터를 올려 persist해야 다음
    // invocation에서 이어서 누적된다. fire-and-forget — 이번 tick 처리를 막지 않는다.
    void demoteToUndergroundIfNeeded(BACKGROUND_LOCATION_TASK).catch((e: unknown) => {
      logger.warn('underground 강등 처리 실패 (graceful)', e);
    });
    // #2381 (Gap A+B) — GPS 좌표가 무효한 이 tick에서, 지하(profile='underground')+lock
    // 조건이면 arvlCd+accel+cellular consensus로 device가 스스로 역 통과를 판정해 발사한다.
    // 플래그 OFF(기본값)면 evaluateUndergroundConsensusFire 내부 첫 줄에서 즉시 no-op —
    // 아래 조건 자체를 생략해 플래그 OFF 경로를 완전히 그대로 유지한다.
    if (isMinimalAlarmEnabled()) {
      try {
        await evaluateUndergroundConsensusFire();
      } catch (e) {
        logger.warn('지하 consensus 처리 실패 (graceful)', e);
      }
    }
    return;
  }

  const { speed } = latest.coords;
  const speedMps = isValidGpsSpeedMps(speed) ? speed : null;

  try {
    const [destJson, sleepJson, routeJson] = await Promise.all([
      AsyncStorage.getItem(DESTINATION_KEY),
      AsyncStorage.getItem(SLEEP_MODE_KEY),
      AsyncStorage.getItem(ROUTE_KEY),
    ]);

    // 경로(목적지) 없으면 백그라운드에서도 실시간 현황 알림을 띄우지 않는다.
    if (!destJson) {
      return;
    }

    let destinationRaw: unknown;
    try {
      destinationRaw = JSON.parse(destJson);
    } catch {
      logger.error('목적지 JSON 파싱 실패');
      return;
    }
    // destinationId 누락 시 trip 식별 불가 → 처리 중단. 정상 trip은 항상 id를 갖는다.
    if (
      !destinationRaw ||
      typeof destinationRaw !== 'object' ||
      typeof (destinationRaw as { id?: unknown }).id !== 'string'
    ) {
      logger.error('목적지에 id가 없음');
      return;
    }
    // 런타임 검증은 id 존재만 확인. Station 나머지 필드는 production write 시점에서 보장된다.
    const destination = destinationRaw as Station;
    const sleepMode = sleepJson ? JSON.parse(sleepJson) === true : false;

    // #527: BG task 호출 간 직전 수용 fix를 AsyncStorage로 들고 시공간 일관성을 검증한다.
    // iOS deferred batch에서 stale 좌표가 섞여 들어오거나 OS가 부정확 fix를 보낼 때 발생하는
    // 비현실 점프(예: 25km/8s)를 drop. trip이 없을 땐 의미가 없어 destJson 통과 이후로 미룬다.
    const currFix: FixSample = { lat, lng, timestamp: latest.timestamp };
    const prevFix = await readBgLastFix();
    if (!isPlausibleJump(prevFix, currFix)) {
      logSuppressedGate('gate-jump', { lat, lng, accuracy, ageMs });
      return;
    }
    await AsyncStorage.setItem(BG_LAST_FIX_KEY, JSON.stringify(currFix));

    // #819 — backend로 단일 좌표 + Motion sample 송신. backend가 KV에 60s ring buffer로 누적해
    // boarding-prompt 9단 게이트(ADR Section 2)에 사용. APNs token 부재 시 skip (서버측 series는
    // device token으로 키되므로 token 없으면 적재 불가). graceful fire-and-forget — 송신 실패는
    // 본 BG task 흐름에 영향 없음 (#640: zero trip = zero push 정책은 그대로, 좌표 누락은 게이트
    // 통과 못 하게 만들 뿐).
    const apnsToken = await AsyncStorage.getItem(APNS_TOKEN_KEY).catch(() => null);
    // #2093 (A) — POST /position 최소 간격 가드. iOS가 신호 재포착 후 배치 catch-up으로 짧은
    // 간격에 TaskManager invocation을 연속 발동시키면 게이트 없이는 uploadPosition이 매 invocation
    // 마다 호출돼 2Hz까지 폭주(evidence: 08:44:15~08:45:11 59회)한다. FG hook과 동일 최소 간격
    // (POSITION_UPLOAD_MIN_INTERVAL_MS)을 AsyncStorage 기반으로 강제 — accel/wifi lookup 등
    // 업로드 준비 비용까지 함께 skip해 발열도 완화한다.
    const lastUploadAt = apnsToken ? await readBgLastPositionUploadAt() : null;
    const now = Date.now();
    const withinUploadCooldown =
      lastUploadAt !== null && now - lastUploadAt < POSITION_UPLOAD_MIN_INTERVAL_MS;
    if (apnsToken && !withinUploadCooldown) {
      await AsyncStorage.setItem(BG_LAST_POSITION_UPLOAD_AT_KEY, String(now));
      // #1542 (ADR-016 S9) — Background Location piggyback: BG task가 호출될 때마다
      // accelerometer fingerprint start를 no-op 보장으로 호출. native 모듈이 isUpdating 가드를
      // 갖고 있어 한 번만 시작되며, 이후 BG location updates 활성 동안 raw 가속도 5Hz가 계속 흐른다.
      // 미지원/실패는 graceful (snapshot 조회가 null로 fallback).
      startAccelerometerFingerprint();
      // #823 — 가속도 latest summary 첨부 (옵션). useAccelerometer가 FG에서 갱신.
      //   BG-only 또는 FG → BG 전환 후 시간이 지난 케이스에 stale snapshot이 남아있을 수 있어
      //   ACCEL_SUMMARY_MAX_AGE_MS 이상 오래된 건 제외 (E1 정책: 결정적 freshness 우선).
      const latestAccel = getLatestAccelSummary();
      const accelSummary =
        latestAccel && Date.now() - latestAccel.endTs <= ACCEL_SUMMARY_MAX_AGE_MS
          ? latestAccel
          : undefined;
      // #1542 — 60s window snapshot pattern 분류. motion 필드와 결합 — accelerometer 'automotive'/
      // 'walking'은 stationary 우선보다 강 신호 (raw 가속도 진동은 CMMotionActivity stationary 5~10분
      // 뒤집힘 mitigation, lesson_motion_activity_intermittent_signal).
      const accelPattern = classifyAccelerometerPattern(getLatestAccelerometerSnapshot());
      const motion: PositionMotion = pickMotionLabel(accelPattern, getCurrentMotionStationary());
      // #1667 (ADR-015 strongDB wire) — WiFi SSID 매핑 역명 산출. await로 동기화해 uploadPosition
      // 에 함께 전달 — WiFi lookup 실패 시 graceful undefined (strongDB false fallback,
      // strongBE/strongCB는 계속 활성). iOS WiFi 미연결 시 null → undefined.
      // `reference_ios_wifi_api_constraint.md`: 사용자가 5G/LTE만 쓰면 항상 undefined.
      const wifiSsid = await getCurrentWifiSsid().catch(() => null);
      const wifiStation = lookupStationBySsid(wifiSsid);
      void uploadPosition({
        token: apnsToken,
        lat,
        lng,
        accuracy: accuracy ?? 0,
        ts: latest.timestamp,
        motion,
        accelSummary,
        ...(wifiStation ? { wifiSsidStationName: wifiStation.name } : {}),
      });
    }

    // #1291 — BG 알람 모션 게이트. FG(`useStationAlarm`/`evaluateMovement`)와 동일 정책:
    // motionStationary=true(주머니 속 정지 확정)이면 GPS 노이즈로 인한 오발사를 차단한다.
    // 위 isLocationFresh/isAccuracyAcceptable 게이트를 통과한 fix에 대해서만 평가한다.
    // evaluateMovement에 motionStationary를 전달해 FG와 동일 판정 로직을 재사용.
    // BG에서는 motion 신선도를 별도로 관리할 수 없으므로 getCurrentMotionStationary()의 graceful
    // fallback(미지원/권한 거절 → false)에 의존한다. false이면 게이트를 건너뛰고 기존 경로를 유지.
    const motionStationary = getCurrentMotionStationary();

    // #2345 — 이 tick은 gate-accuracy를 통과했으므로 연속 실패 streak을 reset하고, 직전까지
    // 'underground'로 강등돼 있었다면 즉시 'surface'(High)로 eager release한다. await하는
    // 이유: 이번 tick에 이미 재시작이 일어났으면(true) 아래 motion 기반 전환을 중복 실행하지
    // 않기 위해 결과가 필요하다(surface→stationary로 바로 재플립하는 낭비 방지).
    const undergroundReleased = await releaseFromUndergroundIfNeeded(BACKGROUND_LOCATION_TASK).catch(
      (e: unknown) => {
        logger.warn('underground release 처리 실패 (graceful)', e);
        return false;
      },
    );

    // #2344 (V8a) — 정지 확정 시 BG location interval을 완화(stationary 프리셋)하고, 이동 재개
    // 시 surface로 즉시 복귀한다. fire-and-forget — stop→start 재시작이 이번 tick의 알람 파이프라인
    // 처리를 막지 않는다(다음 tick부터 새 interval 적용). accuracy는 미접촉, timeInterval만 전환.
    if (!undergroundReleased) {
      void applyBgLocationProfile(
        BACKGROUND_LOCATION_TASK,
        motionStationary === true ? 'stationary' : 'surface',
      ).catch((e: unknown) => {
        logger.warn('BG location profile 전환 실패 (graceful)', e);
      });
    }

    const motionSignal = evaluateMovement(
      { timestamp: latest.timestamp, accuracyM: accuracy ?? undefined, speedMps: speedMps ?? undefined },
      Date.now(),
      undefined,
      // motionStationary=false(이동 중 or 권한 거절)이면 undefined 대신 false를 전달해 motion-warmup 차단 안 함.
      // BG task는 FG hydrate 직후 warmup window 개념이 없으므로 warmup 차단은 의도적으로 배제.
      motionStationary === true ? true : false,
    );
    if (!motionSignal.reliable && motionSignal.reason === 'motion-stationary') {
      logSuppressedGate('gate-motion-stationary', { lat, lng, accuracy, ageMs });
      return;
    }

    // destinationId scoped — 이전 trip의 stale entry는 빈 set으로 반환된다(#462).
    const firedAlarms = await getFiredAlarms(destination.id);
    const storedRoute: Route = routeJson ? JSON.parse(routeJson) : null;

    // lastNotifiedStationId는 stationPipeline 내부에서 notificationState 모듈을 통해
    // AsyncStorage에 직접 read/write 한다 (Foreground 훅과 단일 출처 공유).
    //
    // #784: arrivalAtOrigin / arrivalsAtTransfers를 BG에서 미전달 — calculateStaticETA는 DEFAULT_WAIT_MINUTES
    // fallback으로 흐른다. FG의 arrivalCache는 in-memory TtlCache(useArrivalInfo)라 BG 프로세스에서
    // 접근 불가하고, BG 전용 arrival 폴링은 OS quota 비용 대비 효익이 작다 — BG는 notification 본문
    // ETA 한 곳만 갱신. AsyncStorage 캐시 경로는 측정 결과 BG 정확도 ↑ 효과가 확인되면 후속 도입.
    const { alarmEvent, nearest } = await processLocationUpdate({
      lat,
      lng,
      destination,
      firedAlarms,
      sleepMode,
      storedRoute,
      speedMps,
      source: 'bg',
      // BG task는 fusion을 쓰지 않고 raw GPS만 처리 → 사용자에게 'GPS 추정'을 자백.
      // 실제 BG에서 train data를 쓰게 되면 caller에서 'position-train'으로 바꾼다.
      fusionSource: 'gps',
    });

    if (alarmEvent) {
      firedAlarms.add(alarmKey(alarmEvent));
      await Promise.all([
        setFiredAlarms(destination.id, firedAlarms),
        AsyncStorage.setItem(ALARM_EVENT_KEY, JSON.stringify(alarmEvent)),
      ]);
    }

    // #711: BG task가 평가한 nearest를 BG_LAST_STATION_KEY에 적재.
    // FG 복귀 시 useNearestStation이 fresh fix 도착 전 임시 hydrate에 사용한다.
    // null nearest(역 1km 밖)도 동일 정책으로 처리할 필요는 없다 — 메모리 상 result도 null로 보존됨이 자연스러움.
    if (nearest) {
      await AsyncStorage.setItem(
        BG_LAST_STATION_KEY,
        JSON.stringify({
          station: nearest.station,
          distanceKm: nearest.distanceKm,
          timestamp: latest.timestamp,
        }),
      );
      // #1237 (Phase 2) — 위젯 SSOT 갱신. saveStationToWidget의 module-level 50m bucket dedupe
      // + FRESHNESS_REFRESH_MS는 FG/BG 같은 인스턴스라 자연 동작. null nearest는 호출 X
      // (FG/BG transient null로 widget zap 방지, Phase 3 clear 정책 완화와 정합성).
      // #1929 (F-W3) — tripContext stamp로 SubwayWidget.swift:229 RC-15 expired-gate 활성화.
      // BG는 React state 없으므로 위에서 hydrate된 destination + storedRoute로 helper 호출.
      // currentStation은 BG에서 sticky lock이 없어 nearest로 근사 (위젯은 SSoT mirror, FG fusion이 정확성 보장).
      const bgTripContext = buildWidgetTripContext({
        destination,
        currentStation: nearest.station,
        route: storedRoute,
      });
      await saveStationToWidget(nearest.station, nearest.distanceKm, undefined, undefined, bgTripContext);
    }

    logger.info('백그라운드 위치 업데이트 완료:', lat.toFixed(4), lng.toFixed(4));
  } catch (e) {
    logger.error('백그라운드 태스크 실패:', e);
  }
});
