/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: 이 파일은 의도적으로 여러 features의 hook/util을 조합하는
 * orchestrator 역할이라 직접 import가 본질적이다. Phase 5 enforce 모드에서 file-level disable로
 * 옵트인 처리. 후속 PR(별도 이슈)에서 orchestration 슬라이스(예: features/fusion/, app shell)로
 * 추출하여 disable을 제거할 예정.
 *
 * ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" Phase 5 (#890).
 */
/**
 * #819 — backend로 GPS 좌표 + Motion 송신.
 *
 * 디바이스가 BG/FG location task에서 fix마다 호출. backend가 device token별 series를 KV에
 * 축적해 cron 사이클마다 9단 boarding-prompt 게이트(ADR Section 2)에 사용한다.
 *
 * iOS `client.speed`는 -1/빈 값으로 자주 떨어지는 것이 #812 회귀의 직접 원인 — backend가 좌표
 * series로 평균 속도를 자체 계산하는 것이 정책 (ADR Section 6 step 5).
 *
 * 백엔드 URL 미설정/네트워크 실패는 throw 없이 graceful `{ ok:false, skipped:true }` — Phase 0
 * baseline(사전 예약만)은 그대로 동작한다.
 *
 * #1534 (S1, T9b, ADR-016) — POST /position response body에 backend가 추론한 lockSuggestion +
 * originStationId가 embed된다. 본 모듈이 response를 parse해 BACKEND_SSOT_MIRROR_KEY에 mirror
 * write — `useLockSuggestion` reader hook이 다음 polling cycle에서 read해 lockless trip의
 * lock UX를 즉시 활성화한다 (silent push secondary transport + position primary transport 패턴).
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { fetchWithTimeout, getBackendUrl } from './backendHttp';
import { ACTIVE_BOARDING_LINE_KEY, TRIP_ORIGIN_KEY } from '../../../shared/constants/storageKeys';
import { snapToLinePolyline } from '../../route/utils/linePolyline';
import { isLineNumber } from '../../route/utils/lineGuard';
import { findNearestStation } from '../utils/findNearestStation';
import type { LineNumber } from '../../../shared/types/station';
import { createLogger } from '../../../shared/utils/logger';
import { haversine } from '../../../shared/utils/haversine';
import type { AccelSummary } from '../utils/accelMotion';
import type { CellularEnvironmentVote } from '../utils/cellularTech';
import {
  persistBackendSsotMirror,
  type LockSuggestionMirror,
  type SilentPushSsotMirror,
} from '../../alarm/utils/backendSsotMirror';

const log = createLogger('positionUpload');

/**
 * #828 — 좌표 snap 대상 line을 산출하는 전략 함수.
 *
 * 기본 구현은 `ACTIVE_BOARDING_LINE_KEY`를 읽는 AsyncStorage 백엔드(`readActiveBoardingLine`).
 * 호출자는 multi-trip / multi-line / fallback line 시나리오에 맞춰 자기만의 resolver를
 * 주입할 수 있다. resolver가 null을 반환하면 snap을 skip한다.
 */
export type ActiveLineResolver = () => Promise<LineNumber | null>;

/**
 * 기본 resolver — `ACTIVE_BOARDING_LINE_KEY`를 AsyncStorage에서 읽고 `LineNumber`로 좁힌다.
 * 키 부재 / 잘못된 코드 / AsyncStorage 실패 → null (snap skip, graceful).
 */
export const readActiveBoardingLine: ActiveLineResolver = async () => {
  try {
    const raw = await AsyncStorage.getItem(ACTIVE_BOARDING_LINE_KEY);
    return isLineNumber(raw) ? raw : null;
  } catch {
    return null;
  }
};

export type PositionMotion = 'stationary' | 'walking' | 'automotive' | 'unknown';

export interface PositionUploadPayload {
  /** APNs device token (hex) — backend가 같은 키로 series 적재. */
  token: string;
  lat: number;
  lng: number;
  /** GPS accuracy meters. backend가 ≥ 50m sample은 hop 계산에서 제외. */
  accuracy: number;
  /** epoch ms — 디바이스 측정 시각. backend 시계와의 drift는 평균속도가 자체 보정. */
  ts: number;
  motion: PositionMotion;
  /**
   * #823 Phase 3 E1 — 가속도 1초 window 요약값 (옵션).
   * 디바이스에서 100Hz raw → 1Hz 요약 변환 후 첨부. 부재 시 backend는 가속도 series append를 skip
   * — 기존 #819 게이트는 영향 없음 (E1은 신호 추가만, fusion 사용은 E2 단계 몫).
   */
  accelSummary?: AccelSummary;
  /**
   * #828 Phase 2 fusion — 클라이언트가 active boarding line polyline에 좌표를 사영한 결과.
   * 짝(line+arcM)으로만 의미가 있고 한쪽만 보내면 backend가 둘 다 무시한다.
   * unmatched / boarding line 미설정 시 두 필드 모두 omit (graceful — backend는 GPS-only로 동작).
   */
  mapMatchedLine?: string;
  mapMatchedArcM?: number;
  /**
   * #834 Phase 3 E3-B — 클라가 stations.json 전수 스캔으로 산출한 최근접 역까지의 거리 (m).
   * backend는 stations.json을 갖지 않으므로 거리는 반드시 클라 책임 (`mapMatched*`와 동형).
   * backend `stationPhase.ts`가 APPROACHING/DWELLING/DEPARTING/CRUISING 분류 입력 중
   * 하나로 사용. undefined → phase 산출 skip (회귀 없음, GPS-only fallback).
   * 음수/NaN/Infinity는 backend가 series 단계에서 거부.
   */
  nearestStationDistanceM?: number;
  /**
   * #1363 — 클라가 산출한 "사용자 현재 추정 역" 이름. backend 진단 log(`scheduled.ts`)가
   * `waypoint`(trip 다음 정거장)와 명시적으로 구분해 출력하기 위한 라벨링 전용 필드.
   * 게이트/푸시 결정에는 사용되지 않는다 — 야간 RCA에서 backend 로그가 `station=중곡`이
   * 사용자 실제 위치인지 trip 목표 정거장인지 모호하던 회귀를 해소.
   * undefined/빈 문자열은 backend가 graceful drop (회귀 없음).
   */
  currentStationName?: string;
  /**
   * #1543 (ADR-016 S10) — 디바이스 CTRadioAccessTechnology 환경 vote (`useCellularTech`).
   *
   * - 'surface'            : NR (5G SA) — 지상 hard-reject
   * - 'surface-weak'       : LTE — 지하 DAS 중계 가능, soft downgrade (#1876)
   * - 'surface-weak-nrnsa' : NRNSA — LTE보다 약한 soft downgrade (#2099). device-side
   *   `undergroundSSotConsensus`/`weightedVoteFusion` 전용 분류 — 현재 이 필드를 채워 보내는
   *   caller가 없고(orphan 유사), 채워 보낼 경우 backend `consensusGate`가 5번째 값을 아직
   *   인식하지 못하므로 별도 backend 대응 전까지는 device-local 판정에만 사용한다.
   * - 'underground'        : 2G/3G fallback → 지하 환경 vote
   * - 'unknown' / 미전송    : vote 미투표 (게이트 영향 0)
   *
   * iOS only. Android / 미지원 디바이스 / native module 부재 시 omit (graceful).
   * backend `consensusGate`의 environment contradict 판정에 사용된다.
   *
   * #2099 (P3-1, 리뷰 반영) — 손 복사 union 대신 `cellularTech.ts`의 `CellularEnvironmentVote`를
   * import해 타입 drift 방지 (SSOT 단일화).
   */
  cellularEnvironmentVote?: CellularEnvironmentVote;
  /**
   * #1667 (ADR-015 strongDB wire) — WiFi SSID 매핑으로 결정한 역명.
   *
   * 디바이스가 `lookupStationBySsid(currentWifiSsid)?.name`을 산출해 forward한다.
   * backend는 stations.json을 갖지 않으므로 lookup은 device 책임 (`mapMatchedLine/ArcM`과 동일 패턴).
   *
   * - 매칭 성공: `Station.name` 문자열 (예: '강남')
   * - iOS WiFi 미연결 / 매칭 실패 / Android: undefined → backend strongDB false fallback
   * - `reference_ios_wifi_api_constraint.md` — 사용자가 5G/LTE 전용 시 undefined (graceful).
   */
  wifiSsidStationName?: string;
  /**
   * #2153 (리뷰 P1) — 이 fix와 고정 출발역(`TRIP_ORIGIN_KEY`, #700) 사이 거리(m). backend
   * boarding-prompt 신선도 게이트 anchor(`trip.originProximityAt`)의 실시간 입력.
   *
   * `promptGeoContext.originDistanceM`(POST /trips register 시점 스냅샷)과 달리, 이 필드는
   * `withOriginProximity`가 **매 /position 호출마다** 신선한 GPS fix 기준으로 재계산한다 —
   * 재등록 트리거(currentStation 전환 등)가 안 와도 "실제로 역에 근접했는가"가 항상 최신값으로
   * backend에 전달된다(#2153 RCA: 집에서 route 설정 후 재등록 없이 도보 이동하는 케이스에서
   * 정적 스냅샷이 anchor stamp 기회를 영구히 막던 회귀).
   *
   * TRIP_ORIGIN_KEY 부재(route 미설정) → undefined (graceful, position series 자체는 계속 적재).
   */
  originDistanceM?: number;
  /** #2153 — 위 거리 계산에 쓰인 GPS 정확도(m) — 항상 `accuracy`와 동일값, origin 짝 필드. */
  originAccuracyM?: number;
}

export interface PositionUploadResult {
  ok: boolean;
  skipped?: boolean;
  status?: number;
}

// Seam E (#901) — getBackendUrl/fetchWithTimeout은 backendHttp.ts로 추출 (boardingLockSync도 재사용).

/**
 * #828 — resolver가 반환한 line에 좌표를 사영해 mapMatched 결과를 payload에 첨부.
 *
 * - 호출자가 `mapMatchedLine` + `mapMatchedArcM`을 명시 전달했으면 그대로 사용 (override).
 * - resolver null / unmatched → 두 필드 모두 omit (graceful, GPS-only fallback).
 *
 * resolver를 함수로 주입받아 multi-trip / fallback line / 측정 fixture 같은 미래 확장이
 * 호출자 단에서 자유롭게 결정된다 (CLAUDE.md 글로벌 규칙 3번 — 확장성/재사용성 우선).
 */
export async function withMapMatched(
  payload: PositionUploadPayload,
  resolveLine: ActiveLineResolver = readActiveBoardingLine,
): Promise<PositionUploadPayload> {
  if (payload.mapMatchedLine !== undefined && payload.mapMatchedArcM !== undefined) {
    return payload;
  }
  const line = await resolveLine();
  if (!line) return payload;
  const snap = snapToLinePolyline({ lat: payload.lat, lng: payload.lng }, line);
  if (!snap.matched) return payload;
  return {
    ...payload,
    mapMatchedLine: snap.line,
    mapMatchedArcM: snap.arcM,
  };
}

/**
 * #834 — 좌표를 받아 최근접 역까지의 거리(m)를 반환하는 전략 함수.
 *
 * 기본 구현은 `findNearestStation` (stations.json 528개 전수 스캔, BG sample 당 1회).
 * 호출자는 측정 fixture / spatial index / active-line scoping 등 미래 확장을 위해
 * 자기만의 resolver를 주입할 수 있다. undefined 반환 시 필드 omit (graceful).
 */
export type NearestStationResolver = (lat: number, lng: number) => number | undefined;

/** 1km → 1000m 변환 상수. 매직넘버 분리. */
const METERS_PER_KM = 1000;

/**
 * 기본 resolver — `findNearestStation`이 반환한 km 거리를 m로 변환.
 * null(매칭 실패) → undefined (snap skip, graceful).
 */
export const defaultNearestStationResolver: NearestStationResolver = (lat, lng) => {
  const result = findNearestStation(lat, lng);
  if (!result) return undefined;
  return result.distanceKm * METERS_PER_KM;
};

/**
 * #834 — resolver가 산출한 최근접 역 거리를 payload에 첨부.
 *
 * - 호출자가 `nearestStationDistanceM`을 명시 전달했으면 그대로 사용 (override, resolver 미호출).
 * - resolver undefined → 필드 omit (graceful, GPS-only fallback).
 *
 * `withMapMatched`와 동형 패턴 — resolver를 함수로 주입받아 미래의 spatial index /
 * 측정 fixture / active-line scoping 같은 확장이 호출자 단에서 자유롭게 결정된다.
 */
export function withNearestStationDistance(
  payload: PositionUploadPayload,
  resolve: NearestStationResolver = defaultNearestStationResolver,
): PositionUploadPayload {
  if (payload.nearestStationDistanceM !== undefined) {
    return payload;
  }
  const distanceM = resolve(payload.lat, payload.lng);
  if (distanceM === undefined) return payload;
  return {
    ...payload,
    nearestStationDistanceM: distanceM,
  };
}

/**
 * #2153 — 고정 출발역 좌표를 반환하는 전략 함수. 기본 구현(`readTripOriginCoords`)은
 * `TRIP_ORIGIN_KEY`(destination 설정 시점에 캡처된 route origin, #700)를 읽는다. 호출자는
 * multi-trip / 측정 fixture 확장을 위해 자기만의 resolver를 주입할 수 있다.
 * null 반환 시 근접 계산을 skip(graceful) — `withMapMatched`/`withNearestStationDistance`와 동형.
 */
export type OriginResolver = () => Promise<{ lat: number; lng: number } | null>;

/**
 * 기본 resolver — `TRIP_ORIGIN_KEY`에서 destination 설정 시점 캡처된 `Station`을 읽어
 * lat/lng만 추출한다. 키 부재 / JSON 파싱 실패 / lat·lng 형식 불일치는 null(graceful).
 */
export const readTripOriginCoords: OriginResolver = async () => {
  try {
    const raw = await AsyncStorage.getItem(TRIP_ORIGIN_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { lat?: unknown; lng?: unknown };
    if (typeof parsed.lat !== 'number' || typeof parsed.lng !== 'number') return null;
    return { lat: parsed.lat, lng: parsed.lng };
  } catch {
    return null;
  }
};

/**
 * #2153 (리뷰 P1) — resolver가 반환한 고정 출발역 좌표 대비 이 fix의 거리를 계산해 payload에
 * 첨부한다. `withMapMatched`/`withNearestStationDistance`와 동형 패턴(override 우선, resolver
 * 주입 가능, 실패 시 graceful omit) — 매 호출마다 신선한 GPS 기준으로 재계산되므로 route 설정
 * 시점 스냅샷(promptGeoContext.originDistanceM)과 달리 실시간성이 보장된다.
 *
 * - 호출자가 `originDistanceM` + `originAccuracyM`을 명시 전달했으면 그대로 사용(override).
 * - resolver가 null 반환(route 미설정 등) → 두 필드 모두 omit (graceful).
 * - accuracy는 항상 이 fix의 `payload.accuracy` — origin 계산 자체의 오차가 아니라 GPS fix
 *   정확도이므로 backend `isNearOrigin`의 margin 계산과 register 경로(promptGeoContext)가 동일
 *   의미로 소비한다.
 */
export async function withOriginProximity(
  payload: PositionUploadPayload,
  resolveOrigin: OriginResolver = readTripOriginCoords,
): Promise<PositionUploadPayload> {
  if (payload.originDistanceM !== undefined && payload.originAccuracyM !== undefined) {
    return payload;
  }
  const origin = await resolveOrigin();
  if (!origin) return payload;
  const originDistanceM = Math.round(
    haversine(payload.lat, payload.lng, origin.lat, origin.lng) * METERS_PER_KM,
  );
  return {
    ...payload,
    originDistanceM,
    originAccuracyM: payload.accuracy,
  };
}

export async function uploadPosition(
  payload: PositionUploadPayload,
): Promise<PositionUploadResult> {
  const base = getBackendUrl();
  if (!base) {
    log.info('ALARM_BACKEND_URL not set — skip position upload');
    return { ok: false, skipped: true };
  }
  const mapMatched = await withMapMatched(payload);
  const withNearest = withNearestStationDistance(mapMatched);
  // #2153 — origin 근접 실시간 anchor 입력. AsyncStorage 1회 read 추가(다른 with* 헬퍼와 동일 비용).
  const enriched = await withOriginProximity(withNearest);
  try {
    const res = await fetchWithTimeout(`${base}/position`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(enriched),
    });
    if (!res.ok) {
      log.warn(`position upload failed status=${res.status}`);
      return { ok: false, status: res.status };
    }
    // #1534 (S1, T9b, ADR-016) — POST /position response embed: lockSuggestion + originStationId.
    //
    // backend가 lockless trip을 추론해 lockSuggestion을 결정하면 응답 body에 embed해 회신한다
    // (silent push 도달 안 되는 분기 — OS suspend/kill/저전력 — 에서도 device가 cycle마다
    // 호출하는 /position 응답으로 즉시 인계 가능). device는 BACKEND_SSOT_MIRROR_KEY에 mirror
    // write — useLockSuggestion이 다음 polling cycle에서 read해 useBoardingLockController가
    // 1순위 lock 채택.
    //
    // parse 실패 / 필드 부재 / 형식 mismatch는 silent — device는 기존 9-AND gate fallback.
    // res.json() 실패는 try/catch가 catch — 응답 자체는 ok=true로 caller에 회신.
    try {
      const body = (await res.json()) as Partial<PositionResponseBody> | null;
      // #2261 (ADR-031 Phase 0) — body.ssot도 트리거 조건에 추가. lockless·정지 trip은
      // lockSuggestion/originStationId 없이 ssot만 forward될 수 있다(예: currentStationId는
      // 있으나 아직 lock 합의 전).
      if (body && (body.lockSuggestion || body.originStationId || body.ssot)) {
        await persistFromPositionResponse(body, Date.now());
      }
    } catch {
      // graceful — body parse 실패 시 device 측 fallback으로 자연 동작.
    }
    return { ok: true, status: res.status };
  } catch (e) {
    log.warn('position upload error', e);
    return { ok: false };
  }
}

/**
 * #1534 (S1, T9b) — POST /position response body schema. backend `index.ts`의 응답 형태와 1:1.
 *
 * 둘 다 optional — backend가 SSOT 부재(trip 미등록) 시 embed 하지 않는다 (graceful).
 */
export interface PositionResponseBody {
  ok: boolean;
  /** backend가 추론한 출발/현재 station identifier — 빈 stationId 분기는 omit. */
  originStationId?: string;
  /** backend가 추론한 lock 제안. lockless trip + 강 evidence 합의 시 set. */
  lockSuggestion?: LockSuggestionMirror;
  /**
   * #2261 (ADR-031 Phase 0) — full SSoT (backend `toSilentPushSsot` 축소, silent push payload와
   * 동일 schema). additive 필드 — 기존 originStationId/lockSuggestion과 병존.
   *
   * 존재 시 `persistFromPositionResponse`가 이 값을 그대로 mirror로 채택한다(motionState/
   * lastAdvanceAt/passedStations/alarmEvents/currentStationLine까지 전체 forward) — legacy
   * fallback(originStationId/lockSuggestion만으로 부분 mirror 합성)보다 우선.
   */
  ssot?: SilentPushSsotMirror;
}

/**
 * #1534 (S1, T9b) — POST /position response body에서 SSOT mirror를 빌드해 영속화.
 *
 * silent push가 forward하는 `SilentPushSsotMirror`와 동일 schema로 통합 — device cascade picker
 * + useLockSuggestion 양쪽이 같은 BACKEND_SSOT_MIRROR_KEY를 single source로 read.
 *
 * 본 함수는 response body가 partial 일 때(예: lockSuggestion만 있고 motionState/passedStations
 * 누락) graceful 기본값으로 채워 mirror write를 시도 — useLockSuggestion이 lockSuggestion만 채택
 * 하므로 motionState='unknown', passedStations=[]가 채택 결정에 영향 없다.
 */
export async function persistFromPositionResponse(
  body: Partial<PositionResponseBody>,
  receivedAt: number,
): Promise<void> {
  // #2261 (ADR-031 Phase 0) — body.ssot(full SSoT)가 있으면 그대로 채택한다. 이전에는
  // lockSuggestion 부재 시 lastAdvanceAt이 0으로 고정돼(never fresh) lockless·정지 trip이 이
  // 채널만으로는 영원히 mirror를 갱신할 수 없었다(deadlock의 절반). full ssot는 backend가 실제
  // 추적 중인 motionState/lastAdvanceAt/passedStations/alarmEvents/currentStationLine을 그대로
  // 담고 있어 legacy 부분 합성보다 우선한다.
  if (body.ssot) {
    if (body.ssot.currentStationId.length === 0) return;
    await persistBackendSsotMirror(body.ssot, receivedAt);
    return;
  }
  // legacy fallback — 구 backend(ssot 필드 미forward) 호환. currentStationId는 originStationId
  // fallback. 둘 다 부재면 빈 문자열로 두는 게 적절하나 SilentPushSsotMirror 형식 검증이 빈
  // 문자열을 reject하므로 lockSuggestion.stationId fallback 시도.
  const currentStationId =
    body.originStationId ?? body.lockSuggestion?.stationId ?? '';
  if (currentStationId.length === 0) return;
  const mirror: SilentPushSsotMirror = {
    currentStationId,
    motionState: 'unknown',
    lastAdvanceEvidence: 'seed-override',
    lastAdvanceAt: body.lockSuggestion?.decidedAt ?? 0,
    passedStations: [],
    ...(body.lockSuggestion ? { lockSuggestion: body.lockSuggestion } : {}),
  };
  await persistBackendSsotMirror(mirror, receivedAt);
}

/**
 * boarding-prompt 사용자 [미탑승]/dismiss 통보 (#819 게이트 #9).
 * backend가 trip.boardingPromptState.silencedUntil를 5분 후로 set해 재발사 차단.
 */
export async function dismissBoardingPrompt(token: string): Promise<PositionUploadResult> {
  const base = getBackendUrl();
  if (!base) {
    log.info('ALARM_BACKEND_URL not set — skip boarding-prompt dismiss');
    return { ok: false, skipped: true };
  }
  if (!token) return { ok: false };
  try {
    const res = await fetchWithTimeout(`${base}/boarding-prompt/dismiss`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    if (!res.ok) {
      log.warn(`dismiss failed status=${res.status}`);
      return { ok: false, status: res.status };
    }
    return { ok: true, status: res.status };
  } catch (e) {
    log.warn('dismiss error', e);
    return { ok: false };
  }
}
