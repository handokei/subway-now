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
import { ACTIVE_BOARDING_LINE_KEY } from '../../../shared/constants/storageKeys';
import { snapToLinePolyline } from '../../route/utils/linePolyline';
import { isLineNumber } from '../../route/utils/lineGuard';
import { findNearestStation } from '../utils/findNearestStation';
import type { LineNumber } from '../../../shared/types/station';
import { createLogger } from '../../../shared/utils/logger';
import type { AccelSummary } from '../utils/accelMotion';
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
   * - 'surface'      : 4G/5G 잡힘 → 지상 환경 vote
   * - 'underground'  : 2G/3G fallback → 지하 환경 vote
   * - 'unknown' / 미전송 : vote 미투표 (게이트 영향 0)
   *
   * iOS only. Android / 미지원 디바이스 / native module 부재 시 omit (graceful).
   * backend `consensusGate`의 environment contradict 판정에 사용된다.
   */
  cellularEnvironmentVote?: 'surface' | 'underground' | 'unknown';
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

export async function uploadPosition(
  payload: PositionUploadPayload,
): Promise<PositionUploadResult> {
  const base = getBackendUrl();
  if (!base) {
    log.info('ALARM_BACKEND_URL not set — skip position upload');
    return { ok: false, skipped: true };
  }
  const mapMatched = await withMapMatched(payload);
  const enriched = withNearestStationDistance(mapMatched);
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
      if (body && (body.lockSuggestion || body.originStationId)) {
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
  // currentStationId는 originStationId fallback. 둘 다 부재면 빈 문자열로 두는 게 적절하나
  // SilentPushSsotMirror 형식 검증이 빈 문자열을 reject하므로 lockSuggestion.stationId fallback 시도.
  const currentStationId =
    body.originStationId ?? body.lockSuggestion?.stationId ?? '';
  if (currentStationId.length === 0) return;
  const mirror: SilentPushSsotMirror = {
    currentStationId,
    // #1705 (A1/A3-b) — lockSuggestion.lineId 가 있으면 currentStationLine 으로 stamp (cross-line
    // confusion 차단). lockSuggestion 부재 시 omit (legacy v1 row 와 동일 처리, graceful).
    ...(body.lockSuggestion?.lineId
      ? { currentStationLine: body.lockSuggestion.lineId as SilentPushSsotMirror['currentStationLine'] }
      : {}),
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
