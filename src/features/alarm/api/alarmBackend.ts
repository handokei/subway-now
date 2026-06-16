/**
 * alarm-worker(#338) 백엔드 클라이언트.
 *
 * APNs device token + 활성 트립을 등록/해제한다. 백엔드는 cron으로 도착 정보를
 * 폴링하고 적절한 시점에 silent push로 reschedule을 트리거한다.
 *
 * URL은 `EXPO_PUBLIC_ALARM_BACKEND_URL`로만 주입된다. 미설정 시 모든 호출은
 * graceful skip(`{ok:false, skipped:true}`) — Phase 1 baseline(사전 예약만)으로 동작한다.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Route } from '../../../shared/utils/stationRoute';
import type { ApnsEnv } from '../../../shared/utils/apnsEnv';
import { createLogger } from '../../../shared/utils/logger';
import { ACTIVE_BOARDING_LINE_KEY } from '../../../shared/constants/storageKeys';

const log = createLogger('alarmBackend');

/**
 * #828 — BG/FG location task가 좌표 upload 시 linePolyline snap을 수행할 active boarding line.
 * register/clear 시점에 mirror하여 backgroundLocationTask가 trip 컨텍스트 없이도 snap 가능.
 *
 * AsyncStorage 실패는 graceful — snap이 skip될 뿐 fusion 자체는 Phase 1로 자연 동작.
 */
async function mirrorBoardingLine(line: string | undefined): Promise<void> {
  try {
    if (line && line.length > 0) {
      await AsyncStorage.setItem(ACTIVE_BOARDING_LINE_KEY, line);
    } else {
      await AsyncStorage.removeItem(ACTIVE_BOARDING_LINE_KEY);
    }
  } catch (e) {
    log.warn('mirror boarding line failed', e);
  }
}

// AlarmWaypoint는 shared/types/alarm으로 추출됨 (#890, Phase 5).
// 기존 호출자(route/utils/routeWaypoints 등) 호환을 위해 re-export 유지.
// 백엔드 Trip.Waypoint와 동일 구조. backend/alarm-worker/src/types.ts와 동기화.
import type { AlarmWaypoint } from '../../../shared/types/alarm';
export type { AlarmWaypoint };

/**
 * 백엔드 Trip.boardingLock과 동일 구조 (#622). backend/alarm-worker/src/types.ts의
 * `BoardingLockMeta`와 schema 동기화 — backend parseBoardingLock(index.ts:272)이 모든 필드를 검증한다.
 * 한 필드라도 어긋나면 backend가 boardingLock만 drop하고 trip은 살린다.
 */
export interface AlarmBoardingLock {
  /** Seoul API btrainNo (예: "7246") — 사용자가 탭한 열차. */
  trainCode: string;
  /** 현재 leg의 노선 (Waypoint.line과 동일 표기). */
  line: string;
  /** Seoul API subwayId (예: "1007") — 환승 노선 구분용. */
  subwayId: string;
  /** 사용자가 선택한 열차 출발 시각 (epoch ms) — 보통 client BoardingLock.boardedAt. */
  selectedDepartureTime: number;
  /** 현 BoardingLock 구간 내 정차역 시퀀스 (출발역 → 구간 끝). backend가 indexOf로 위치 계산. */
  segmentStations: string[];
  /** Lock 자동 만료 시각 (epoch ms). */
  expiresAt: number;
}

export interface RegisterTripPayload {
  /** APNs device token (hex) */
  token: string;
  route: NonNullable<Route>;
  /** 목적지 역 ID — stations.json id (예: "0228") */
  destination: string;
  waypoints: AlarmWaypoint[];
  /** epoch ms — 트립 등록 시각 (기본: Date.now()) */
  createdAt?: number;
  /** epoch ms — 자동 만료 시각 (기본: createdAt + 2시간) */
  expiresAt?: number;
  /** epoch ms — 알람 발사 예상 시각 (5분 윈도우 진입 판정용) */
  alarmAtEpochMs: number;
  /** APNs 토큰 환경 — backend가 sandbox/production host를 선택. */
  apnsEnv: ApnsEnv;
  /**
   * BoardingLock metadata (#622). 사용자가 탑승 열차를 확정한 경우 함께 보내 backend가 trainCode
   * 기준으로 추적·reschedule 가능. 없으면 backend는 기존 anchor waypoint 폴링으로 fallback.
   */
  boardingLock?: AlarmBoardingLock;
  /**
   * #816 C — 사용자 명시 opt-in (lockless station-passed).
   * true면 BoardingLock 없는 trip에서도 backend가 intermediate waypoint 통과 시
   * station-passed(silent push)를 발사한다. 미송신/false면 기존 #640 게이트 그대로 (lock 부재 → skip).
   *
   * 토글 OFF 상태에선 false를 명시 송신할 필요 없음 — alarmBackend는 미송신 시 backend에서
   * default OFF로 해석. dedup hash에는 반드시 포함해 토글 변경이 즉시 재등록되도록 한다.
   */
  locklessStationPassed?: boolean;
  /**
   * #819 — boarding-prompt 9단 게이트 평가에 필요한 출발역/다음역 좌표.
   * lockMissing trip에 대해 backend가 평가 — 좌표 부재 시 backend는 자동 skip.
   */
  promptGeoContext?: {
    origin: { lat: number; lng: number };
    nextStation: { lat: number; lng: number };
    /** 출발역에서 trip 방향 (Seoul API의 isUp과 정합). 모르면 null — 양방향 허용. */
    direction: 'up' | 'down' | null;
  };
  /**
   * #819 — boarding-prompt push 본문에 노출할 출발역/노선 표시명.
   * 좌표(promptGeoContext)와 짝으로 보내야 backend가 평가 결과 push를 빌드할 수 있다.
   */
  promptDisplay?: {
    originStation: string;
    line: string;
  };
  /**
   * #903 (Seam G) — 등록 시점 기압계가 지하 진입을 시사하는가.
   * true면 backend가 consecutiveEtaMissing threshold를 5→10으로 늘려 일시 GPS/arrival
   * 누락에 더 인내한다(지하 dead zone일 때 trainCode 추적이 자주 끊김).
   * false/미설정은 기존 동작 그대로 — 기압계 미지원/권한 거절 환경 graceful.
   */
  subsurface?: boolean;
}

export interface AlarmBackendResult {
  ok: boolean;
  /** URL 미설정 등으로 호출이 건너뛰어진 경우 true. */
  skipped?: boolean;
  status?: number;
}

/** 기본 트립 TTL — 2시간. 백엔드 KV expiration과 정렬. */
const DEFAULT_TRIP_TTL_MS = 2 * 60 * 60 * 1000;
/** fetch 타임아웃 — 백엔드 응답 지연으로 알람 등록이 차단되지 않도록 짧게 유지. */
const REQUEST_TIMEOUT_MS = 5000;
/**
 * register dedup 시 `alarmAtEpochMs`를 묶는 버킷(ms).
 *
 * `alarmAtEpochMs = now + ETA*1000`이므로 Open API ETA가 30~60초 단위로 흔들리면
 * 매 GPS 폴링마다 다른 값이 된다. 버킷 단위(60s)로 떨어뜨려 동일 트립의 잔jitter를
 * 흡수한다. 정확한 발사 시각은 백엔드 cron이 reschedule로 자체 보정한다.
 */
const ALARM_TIME_BUCKET_MS = 60 * 1000;

/**
 * 마지막으로 백엔드에 성공적으로 등록된 트립 페이로드의 해시.
 *
 * 디바이스 hook(`useApnsTripRegistration`)이 GPS/ETA 변동마다 useEffect를
 * 재실행하는 경우 의미상 동일한 페이로드로 POST /trips가 분당 수회 폭주한다(#581).
 * 모듈 레벨에 마지막 해시를 보관해 동일 페이로드는 fetch 없이 `{ok:true, skipped:true}`로
 * 응답한다. `clearActiveTrip` 호출 시 초기화되어 같은 트립의 재등록(예: 사용자가
 * 트립을 종료 후 곧바로 다시 시작)도 정상 동작한다.
 */
let lastRegisteredHash: string | null = null;

/**
 * In-flight register Promise dedup (#701).
 *
 * `lastRegisteredHash`만으로는 hash check ↔ fetch resolve 사이 round-trip 동안
 * 동일 hash의 register가 동시 발사되면 모두 hash 미일치로 통과해 POST /trips가
 * race로 폭주한다 (Cloudflare 로그: 같은 ms에 3개 도착). 모듈 레벨 Map에 hash →
 * in-flight Promise를 보관해 같은 hash의 동시 호출은 첫 Promise를 공유한다.
 * 완료 시 entry는 제거되고 결과는 `lastRegisteredHash`에 기록된다.
 */
const inFlightRegisters = new Map<string, Promise<AlarmBackendResult>>();

function buildRegisterHash(body: {
  token: string;
  route: NonNullable<Route>;
  destination: string;
  waypoints: AlarmWaypoint[];
  alarmAtEpochMs: number;
  apnsEnv: ApnsEnv;
  boardingLock?: AlarmBoardingLock;
  locklessStationPassed?: boolean;
  promptDisplay?: { originStation: string; line: string };
  subsurface?: boolean;
}): string {
  return JSON.stringify({
    token: body.token,
    route: body.route,
    destination: body.destination,
    waypoints: body.waypoints,
    alarmBucket: Math.floor(body.alarmAtEpochMs / ALARM_TIME_BUCKET_MS),
    apnsEnv: body.apnsEnv,
    // boardingLock 변경 — trainCode/line 또는 segmentStations 갱신 시 즉시 재등록 보장.
    // expiresAt은 dedup 대상 아님 (시간 흐름으로 자연 변동).
    boardingLockKey: body.boardingLock
      ? `${body.boardingLock.trainCode}|${body.boardingLock.line}|${body.boardingLock.subwayId}|${body.boardingLock.segmentStations.join(',')}`
      : null,
    // #816 C — 토글 변경 즉시 backend로 전달되도록 dedup key에 포함.
    // undefined와 false를 다르게 다루지 않는다 — 둘 다 OFF 동일 효과.
    locklessStationPassed: body.locklessStationPassed === true,
    // #819 — promptDisplay(출발역/라인)가 바뀌면 backend가 보내는 push 본문이 달라지므로 dedup 키 일부.
    // 좌표(promptGeoContext)는 GPS jitter로 매번 약간씩 흔들리므로 hash에 안 넣어 폭주 방지 — backend가
    // 게이트 평가 시점에 KV series로 자체 계산하니 영향 없음.
    promptDisplayKey: body.promptDisplay
      ? `${body.promptDisplay.originStation}|${body.promptDisplay.line}`
      : null,
    // #903 (Seam G) — subsurface 토글이 바뀌면 backend threshold가 즉시 갱신되도록 dedup 키 포함.
    // 빈번한 ON/OFF jitter는 useBarometer의 60s 윈도우 평가가 자체 흡수하므로 폭주 위험 낮음.
    subsurface: body.subsurface === true,
  });
}

/** 테스트용 — 모듈 dedup 상태 초기화 (완료 캐시 + in-flight Map). */
export function __resetAlarmBackendDedup(): void {
  lastRegisteredHash = null;
  inFlightRegisters.clear();
}

function getBackendUrl(): string | null {
  const url = process.env.EXPO_PUBLIC_ALARM_BACKEND_URL;
  if (!url) return null;
  return url.replace(/\/$/, '');
}

async function fetchWithTimeout(input: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function performRegisterFetch(
  base: string,
  payload: RegisterTripPayload,
  hash: string,
): Promise<AlarmBackendResult> {
  const createdAt = payload.createdAt ?? Date.now();
  const expiresAt = payload.expiresAt ?? createdAt + DEFAULT_TRIP_TTL_MS;
  const body = {
    token: payload.token,
    route: payload.route,
    destination: payload.destination,
    waypoints: payload.waypoints,
    createdAt,
    expiresAt,
    alarmAtEpochMs: payload.alarmAtEpochMs,
    apnsEnv: payload.apnsEnv,
    // boardingLock은 있을 때만 송신 (없으면 backend는 기존 anchor 폴링).
    ...(payload.boardingLock ? { boardingLock: payload.boardingLock } : {}),
    // #816 C — 토글 ON일 때만 송신. OFF/미설정은 필드 자체를 누락해 기존 trip schema 호환.
    ...(payload.locklessStationPassed === true ? { locklessStationPassed: true } : {}),
    // #819 — boarding-prompt 평가 컨텍스트. 좌표/표시 둘 중 하나라도 없으면 backend는 자동 skip.
    ...(payload.promptGeoContext ? { promptGeoContext: payload.promptGeoContext } : {}),
    ...(payload.promptDisplay ? { promptDisplay: payload.promptDisplay } : {}),
    // #903 (Seam G) — 지하 진입 신호. ON일 때만 송신. backend는 부재 시 false default로 기존 threshold(5) 적용.
    ...(payload.subsurface === true ? { subsurface: true } : {}),
  };

  try {
    const res = await fetchWithTimeout(`${base}/trips`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      log.warn(`register failed status=${res.status}`);
      return { ok: false, status: res.status };
    }
    lastRegisteredHash = hash;
    return { ok: true, status: res.status };
  } catch (e) {
    log.warn('register error', e);
    return { ok: false };
  }
}

/**
 * 활성 트립을 등록한다. 백엔드 URL이 없거나 호출이 실패해도 throw하지 않고
 * `{ok:false}`를 반환 — 알람 사전 예약(#334)은 그대로 동작한다.
 *
 * Dedup 2-layer (#581, #701):
 *   1) `lastRegisteredHash` — 직전 성공 register의 hash와 동일하면 즉시 skip.
 *   2) `inFlightRegisters` — 같은 hash로 이미 fetch 중이면 그 Promise를 공유 (race 차단).
 */
export function registerActiveTrip(
  payload: RegisterTripPayload,
): Promise<AlarmBackendResult> {
  const base = getBackendUrl();
  if (!base) {
    log.info('ALARM_BACKEND_URL not set — skip register');
    return Promise.resolve({ ok: false, skipped: true });
  }

  const hash = buildRegisterHash({
    token: payload.token,
    route: payload.route,
    destination: payload.destination,
    waypoints: payload.waypoints,
    alarmAtEpochMs: payload.alarmAtEpochMs,
    apnsEnv: payload.apnsEnv,
    boardingLock: payload.boardingLock,
    locklessStationPassed: payload.locklessStationPassed,
    promptDisplay: payload.promptDisplay,
    subsurface: payload.subsurface,
  });
  if (hash === lastRegisteredHash) {
    return Promise.resolve({ ok: true, skipped: true });
  }

  // 같은 hash로 이미 in-flight fetch가 있으면 그 Promise를 그대로 반환 — TOCTOU race
  // (hash check ↔ fetch resolve 사이 동시 호출)로 POST /trips가 동시 발사되는 것을 차단.
  const pending = inFlightRegisters.get(hash);
  if (pending) {
    return pending;
  }

  // #828 — BG/FG location task가 snap에 사용할 boarding line을 mirror. fetch와 병렬로 발사해
  // register와 무관하게 (URL 미설정 graceful 경로에서도) 다음 좌표 upload부터 효과.
  void mirrorBoardingLine(payload.promptDisplay?.line);

  const promise = performRegisterFetch(base, payload, hash).finally(() => {
    inFlightRegisters.delete(hash);
  });
  inFlightRegisters.set(hash, promise);
  return promise;
}

/**
 * silent push 처리 결과 ACK (#568 P2b). 백엔드 #566 P2a `/push/ack` endpoint 호출.
 * 백엔드가 pushId 발급 시 KV에 저장한 token과 매칭해 임의 echo를 차단하므로
 * caller는 디바이스의 APNs token을 함께 전달해야 한다.
 * URL 미설정/네트워크 실패 시 throw 없이 `{ok:false}` — 본 silent push 처리는 영향 없음.
 */
export interface PushAckPayload {
  pushId: string;
  token: string;
  // #1370 L5 — `received` outcome은 게이트 평가 전 push 도달 stamp만 기록한다.
  //   backend는 pending entry를 삭제하지 않고 KV에 `received:<pushId>` stamp만 저장 →
  //   RCA 시 pushed(backend tail) vs received(stamp) 1:1 비교 가능.
  outcome: 'received' | 'fired' | 'skipped';
  reason?: string;
}

export async function sendPushAck(payload: PushAckPayload): Promise<AlarmBackendResult> {
  const base = getBackendUrl();
  if (!base) {
    log.info('ALARM_BACKEND_URL not set — skip push ack');
    return { ok: false, skipped: true };
  }
  try {
    const res = await fetchWithTimeout(`${base}/push/ack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      log.warn(`push ack failed status=${res.status}`);
      return { ok: false, status: res.status };
    }
    return { ok: true, status: res.status };
  } catch (e) {
    log.warn('push ack error', e);
    return { ok: false };
  }
}

/**
 * 활성 트립을 해제한다. URL/네트워크 실패 시에도 throw하지 않는다 — 백엔드 KV는
 * `expiresAt`으로 자동 정리되므로 클라이언트가 재시도 책임을 갖지 않는다.
 */
export async function clearActiveTrip(token: string): Promise<AlarmBackendResult> {
  // 트립 종료 후 동일 트립을 다시 시작할 수 있도록 dedup 캐시를 초기화한다.
  // URL 미설정/네트워크 실패 경로에서도 초기화해야 클라이언트가 register dedup에
  // 의도치 않게 갇히지 않는다. in-flight Promise까지 비워야 clear 직후 register가
  // 이전 Promise를 재사용하지 않는다.
  lastRegisteredHash = null;
  inFlightRegisters.clear();
  // #828 — trip 종료 시 mirror도 제거. 다음 좌표 upload부터 snap skip(graceful).
  void mirrorBoardingLine(undefined);

  const base = getBackendUrl();
  if (!base) {
    log.info('ALARM_BACKEND_URL not set — skip clear');
    return { ok: false, skipped: true };
  }
  if (!token) return { ok: false };

  try {
    const res = await fetchWithTimeout(`${base}/trips/${encodeURIComponent(token)}`, {
      method: 'DELETE',
    });
    if (!res.ok) {
      log.warn(`clear failed status=${res.status}`);
      return { ok: false, status: res.status };
    }
    return { ok: true, status: res.status };
  } catch (e) {
    log.warn('clear error', e);
    return { ok: false };
  }
}

/**
 * boarding-prompt 응답 측정 (#827).
 *
 * 사용자가 "탑승했냐?" 푸시에 응답한 결과를 backend `/metrics/boarding-prompt`로 보낸다.
 * `boarded` / `dismissed` 두 outcome만 허용. dismiss 시 silencedUntil 갱신은 별도
 * `/boarding-prompt/dismiss` endpoint에서 수행 — 본 호출은 측정 only(부수효과 없음).
 *
 * URL 미설정/네트워크 실패 시 throw 없이 `{ok:false}` — measurement loss는 발생하지만 본
 * 알람 흐름에는 영향 없음.
 */
export type BoardingPromptOutcome = 'boarded' | 'dismissed';

export async function reportBoardingPromptOutcome(
  token: string,
  outcome: BoardingPromptOutcome,
): Promise<AlarmBackendResult> {
  const base = getBackendUrl();
  if (!base) {
    log.info('ALARM_BACKEND_URL not set — skip boarding-prompt metric');
    return { ok: false, skipped: true };
  }
  if (!token) return { ok: false };
  try {
    const res = await fetchWithTimeout(`${base}/metrics/boarding-prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, outcome }),
    });
    if (!res.ok) {
      log.warn(`boarding-prompt metric failed status=${res.status}`);
      return { ok: false, status: res.status };
    }
    return { ok: true, status: res.status };
  } catch (e) {
    log.warn('boarding-prompt metric error', e);
    return { ok: false };
  }
}

/**
 * Live Activity push token 등록 (#586 B/C).
 * native가 emit한 push token hex를 backend의 trip 레코드에 보관한다.
 * URL 미설정/네트워크 실패는 throw 없이 `{ok:false}` — LA 자체는 정상 동작한다.
 */
export async function registerLiveActivityToken(
  tripToken: string,
  activityPushToken: string,
): Promise<AlarmBackendResult> {
  const base = getBackendUrl();
  if (!base) {
    log.info('ALARM_BACKEND_URL not set — skip LA register');
    return { ok: false, skipped: true };
  }
  try {
    const res = await fetchWithTimeout(`${base}/live-activity/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tripToken, activityPushToken }),
    });
    if (!res.ok) {
      log.warn(`LA register failed status=${res.status}`);
      return { ok: false, status: res.status };
    }
    return { ok: true, status: res.status };
  } catch (e) {
    log.warn('LA register error', e);
    return { ok: false };
  }
}

/**
 * Live Activity push token 해제 (#586 B/C).
 * trip이 끝났거나 사용자가 LA를 dismiss했을 때 호출.
 */
export async function clearLiveActivityToken(
  tripToken: string,
): Promise<AlarmBackendResult> {
  const base = getBackendUrl();
  if (!base) {
    log.info('ALARM_BACKEND_URL not set — skip LA clear');
    return { ok: false, skipped: true };
  }
  if (!tripToken) return { ok: false };
  try {
    const res = await fetchWithTimeout(
      `${base}/live-activity/${encodeURIComponent(tripToken)}`,
      { method: 'DELETE' },
    );
    if (!res.ok) {
      log.warn(`LA clear failed status=${res.status}`);
      return { ok: false, status: res.status };
    }
    return { ok: true, status: res.status };
  } catch (e) {
    log.warn('LA clear error', e);
    return { ok: false };
  }
}
