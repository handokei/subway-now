/**
 * APNs HTTP/2 silent push 발사기.
 *
 * Cloudflare Workers는 fetch가 자동으로 HTTP/2를 사용하며 APNs 토큰 인증(JWT)을 지원한다.
 * JWT는 ES256(secp256r1) — `jose`로 .p8 PEM을 import하여 서명한다.
 */

import { importPKCS8, SignJWT } from 'jose';
import type { AlarmPhase } from './alarm';
import { TRIP_ENDED_ALERT_BODY, TRIP_ENDED_ALERT_TITLE } from './alertContent';
import type {
  BoardingPromptPushPayload,
  RescheduleChannel,
  ReschedulePushPayload,
  TripEndedAlertPushPayload,
  TripEndedReason,
} from './types';

/**
 * iOS UNNotificationCategory 식별자 (#819 B 슬라이스). 클라이언트는 같은 식별자로
 * `Notifications.setNotificationCategoryAsync('BOARDING_PROMPT', ...)`로 [탑승]/[미탑승]
 * 액션을 등록한다. 푸시 payload `aps.category`로 매칭.
 */
export const BOARDING_PROMPT_CATEGORY = 'BOARDING_PROMPT';

/**
 * APNs JWT는 1시간 이내 재사용 가능. Worker 인스턴스 메모리에 캐시한다.
 * JWT는 host와 독립적(keyId/teamId 만으로 서명)이므로 self-heal에서
 * sandbox↔production host를 바꿔도 동일 JWT를 재사용한다.
 */
interface JwtCache {
  token: string;
  expiresAt: number;
}

const JWT_TTL_MS = 50 * 60 * 1000; // 50분 (APNs는 1시간이지만 여유)

let jwtCache: JwtCache | null = null;

export interface ApnsConfig {
  keyId: string;
  teamId: string;
  privateKeyPem: string;
  bundleId: string;
}

export interface SilentPushPayload {
  nextWaypoint: string;
  etaSeconds: number;
  phase: AlarmPhase;
  /** Waypoint 종류. 클라가 intermediate일 때만 즉시 알림 발사하도록 분기 (#416). */
  kind: 'transfer' | 'destination' | 'intermediate';
  /**
   * 백엔드 발사 시점 epoch ms (#478 측정 인프라).
   * 클라 수신 시각과 비교해 silent push 도달 지연 분포 측정용.
   */
  sentAt: number;
  /**
   * push 1건의 unique 식별자 (#566 P2a).
   * 디바이스는 처리 결과를 `POST /push/ack`로 보낼 때 이 id를 echo한다.
   * P2c가 30s 미ACK push를 alert fallback으로 재발사할 때 dedup 키로도 사용.
   */
  pushId: string;
  /**
   * Epic #1204 그룹 2 D3 (#1273) — 발사 시점 waypoint의 원본 hop index.
   * 디바이스 `silentPushLocationGate`가 D1 estimator의 currentHopIndex와 비교해 hop-window-match
   * 분기/`gate-no-location` fallback에 사용한다. 구 backend 호환을 위해 optional — 미전달 시
   * 클라이언트는 hop 매칭 분기를 자연 skip하고 거리 게이트만 수행한다.
   */
  hopIndex?: number;
  /**
   * #1365 — 발사 시점 waypoint의 line(`Waypoint.line`). server-authoritative.
   * 환승역에서 같은 hop index에 line이 다른 stop이 존재할 수 있어, 디바이스 `silentPushLocationGate`가
   * D1 estimator의 currentLine과 cross-validation해 잘못된 line의 알람 발사를 차단한다.
   * 구 backend 호환을 위해 optional — 미전달 시 클라이언트는 line cross-check를 자연 skip한다.
   */
  occupiedLine?: string;
  /**
   * #1307 — 발사 시점 trip의 지하(subsurface) 판정. server-authoritative.
   * 지하에서는 WiFi/cell 보정으로 GPS가 stale/spoof되어 디바이스 위치 게이트가
   * 정상 intermediate push를 out-of-range로 오거부한다. 클라이언트는 이 flag로
   * 게이트 거리 검증을 우회한다(`silentPushLocationGate`). 디바이스의 FG-only
   * subsurface stamp가 BG에서 stale 되어도 server flag가 우선이라 BG에서도 동작.
   * 구 backend 호환을 위해 optional — 미전달(또는 false) 시 wire에서 자연 누락,
   * 클라이언트는 기존 거리 게이트로 동작.
   */
  subsurface?: boolean;
  /**
   * #1322 — lock-path fire의 boardingLock 노선(`BoardingLockMeta.line`). server-authoritative.
   * 디바이스가 로컬 lock 없이도(지하 auto-lock hydration window 등) lock-path push(transfer/
   * destination/imminent)의 line sanity-guard를 돌려 발사할 수 있게 한다. 이게 없으면 디바이스는
   * 로컬 lock 부재 + non-intermediate push를 stale race로 보고 `lockless-non-intermediate` drop한다.
   * 구 backend 호환 위해 optional — 미전달 시 wire에서 누락, 디바이스는 기존 보수 동작으로 fallback.
   */
  boardingLine?: string;
  /**
   * #1322 — lock-path fire의 boardingLock trainCode. server가 선택한 열차 식별자.
   * boardingLine과 함께 디바이스에 어떤 열차/노선 발사인지 알린다(진단/로그용). 구 backend 호환 위해
   * optional — 미전달 시 wire에서 누락.
   */
  trainCode?: string;
}

export async function buildApnsJwt(config: ApnsConfig, now: number = Date.now()): Promise<string> {
  if (jwtCache && jwtCache.expiresAt > now + 60_000) {
    return jwtCache.token;
  }
  const key = await importPKCS8(config.privateKeyPem, 'ES256');
  const issuedAtSec = Math.floor(now / 1000);
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: config.keyId })
    .setIssuer(config.teamId)
    .setIssuedAt(issuedAtSec)
    .sign(key);
  jwtCache = { token, expiresAt: now + JWT_TTL_MS };
  return token;
}

/** 테스트용 — 캐시 리셋. */
export function resetApnsJwtCache(): void {
  jwtCache = null;
}

export interface SendPushOptions {
  deviceToken: string;
  payload: SilentPushPayload;
  config: ApnsConfig;
  /** APNs 엔드포인트 host. trip의 apnsEnv에 따라 sandbox/production 중 선택해 전달. */
  host: string;
  fetchImpl?: typeof fetch;
  now?: number;
}

export interface SendPushResult {
  ok: boolean;
  status: number;
  reason?: string;
}

export async function sendSilentPush(options: SendPushOptions): Promise<SendPushResult> {
  const jwt = await buildApnsJwt(options.config, options.now);
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `https://${options.host}/3/device/${options.deviceToken}`;

  const body = JSON.stringify({
    aps: { 'content-available': 1 },
    data: {
      nextWaypoint: options.payload.nextWaypoint,
      etaSeconds: options.payload.etaSeconds,
      phase: options.payload.phase,
      kind: options.payload.kind,
      sentAt: options.payload.sentAt,
      pushId: options.payload.pushId,
      // Epic #1204 그룹 2 D3 (#1273) — payload.hopIndex가 정의된 경우에만 wire.
      // 구 backend 호환을 위해 optional이라 undefined일 땐 JSON에서 자연 누락된다.
      ...(options.payload.hopIndex === undefined ? {} : { hopIndex: options.payload.hopIndex }),
      // #1365 — occupiedLine은 정의된 경우에만 wire. 미전달 시 JSON에서 자연 누락 →
      // 구 client(필드 무시) 및 구 backend payload(미존재)와 byte-level 호환.
      ...(options.payload.occupiedLine === undefined
        ? {}
        : { occupiedLine: options.payload.occupiedLine }),
      // #1307 — subsurface는 true일 때만 wire. false/undefined는 JSON에서 자연 누락 →
      // 구 client(필드 무시) 및 구 backend payload(미존재)와 byte-level 호환.
      ...(options.payload.subsurface === true ? { subsurface: true } : {}),
      // #1322 — boardingLine/trainCode는 정의된 경우에만 wire (lock-path fire). 미전달 시
      // JSON에서 자연 누락 → 구 client(필드 무시) 및 구 backend payload(미존재)와 byte-level 호환.
      ...(options.payload.boardingLine === undefined
        ? {}
        : { boardingLine: options.payload.boardingLine }),
      ...(options.payload.trainCode === undefined ? {} : { trainCode: options.payload.trainCode }),
    },
  });

  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      authorization: `bearer ${jwt}`,
      'apns-topic': options.config.bundleId,
      'apns-push-type': 'background',
      'apns-priority': '5',
      'content-type': 'application/json',
    },
    body,
  });

  if (response.ok) return { ok: true, status: response.status };
  return parseApnsError(response);
}

/**
 * Alert push 발사 (#572 P2c). silent push와 헤더/payload가 다르다:
 *   - apns-push-type: alert (silent은 background)
 *   - apns-priority: 10 (silent은 5)
 *   - aps.alert: { title, body } (silent은 content-available)
 *   - aps.sound: default
 *
 * data.pushId는 silent과 동일 — 디바이스 P2e가 dedup에 사용.
 */
export interface SendAlertPushOptions {
  deviceToken: string;
  title: string;
  body: string;
  pushId: string;
  config: ApnsConfig;
  host: string;
  fetchImpl?: typeof fetch;
  now?: number;
}

export async function sendAlertPush(options: SendAlertPushOptions): Promise<SendPushResult> {
  const jwt = await buildApnsJwt(options.config, options.now);
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `https://${options.host}/3/device/${options.deviceToken}`;

  const body = JSON.stringify({
    aps: {
      alert: { title: options.title, body: options.body },
      sound: 'default',
    },
    data: { pushId: options.pushId },
  });

  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      authorization: `bearer ${jwt}`,
      'apns-topic': options.config.bundleId,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'content-type': 'application/json',
    },
    body,
  });

  if (response.ok) return { ok: true, status: response.status };
  return parseApnsError(response);
}

/**
 * Reschedule silent push (#585). 디바이스 사전 예약 알람(#584)의 도착 시각이 backend 관측과
 * 어긋났을 때 발사. 디바이스는 받아서 기존 예약 cancel + newArrivalTimeEpoch로 재예약한다.
 *
 * silent push와 동일 헤더(background, priority 5)지만 payload의 `kind: 'reschedule'`로 구분.
 * 일반 phase silent push와 달리 alert fallback 대상이 아니다 — 정정 신호 미도달 시 디바이스의
 * 사전 예약이 SLA를 보장하므로 graceful.
 */
export interface SendReschedulePushOptions {
  deviceToken: string;
  pushId: string;
  trainCode: string;
  nextStation: string;
  newArrivalTimeEpoch: number;
  sentAt: number;
  config: ApnsConfig;
  host: string;
  fetchImpl?: typeof fetch;
  now?: number;
  /**
   * #918 A3 PR4 — 정정 대상 scheduler 채널. 미지정 시 구 backend 동작 보존
   * (`channels` 필드를 payload에서 omit → 클라가 `['bl']` 단독으로 해석).
   * 신규 호출자(maybeReschedulePush)는 `RESCHEDULE_CHANNELS_DEFAULT`(['bl','tba'])를 넘긴다.
   */
  channels?: ReadonlyArray<RescheduleChannel>;
  /**
   * #1193 — `tba:` 채널 정정 대상 occurrence(0-based). nextStation이 route에 중복 등장하면
   * `Trip.waypoints[i].occurrenceIdx`를 그대로 forward한다. 미지정 시 wire에 필드를 넣지 않음
   * (구 client는 0 fallback, 구 backend payload와 byte-level 호환).
   */
  occurrenceIdx?: number;
}

export async function sendReschedulePush(
  options: SendReschedulePushOptions,
): Promise<SendPushResult> {
  const jwt = await buildApnsJwt(options.config, options.now);
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `https://${options.host}/3/device/${options.deviceToken}`;

  const payload: ReschedulePushPayload = {
    pushId: options.pushId,
    kind: 'reschedule',
    trainCode: options.trainCode,
    nextStation: options.nextStation,
    newArrivalTimeEpoch: options.newArrivalTimeEpoch,
    sentAt: options.sentAt,
    // channels 미지정 시 wire에 필드를 넣지 않음 — 구 backend payload와 byte-level 호환.
    ...(options.channels !== undefined ? { channels: options.channels } : {}),
    // #1193 — occurrenceIdx도 동일하게 conditional spread. 미지정 또는 0이면 wire에서 생략해
    // 구 client(필드 무시) 및 구 backend payload(미존재)와 byte-level 호환을 보존한다.
    // 0은 base identifier(`tba:early:역`)로 매핑돼 클라가 자연 fallback하므로 생략해도 의미 동일.
    ...(options.occurrenceIdx !== undefined && options.occurrenceIdx > 0
      ? { occurrenceIdx: options.occurrenceIdx }
      : {}),
  };

  const body = JSON.stringify({ aps: { 'content-available': 1 }, data: payload });

  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      authorization: `bearer ${jwt}`,
      'apns-topic': options.config.bundleId,
      'apns-push-type': 'background',
      'apns-priority': '5',
      'content-type': 'application/json',
    },
    body,
  });

  if (response.ok) return { ok: true, status: response.status };
  return parseApnsError(response);
}

/**
 * Trip ended alert push (#1337). server-side trip auto-end 시 사용자에게 즉시 표시되는 alert.
 *
 * 구 silent push(`content-available: 1`, priority 5)는 force-quit된 앱에 전달되지 않아 killed
 * 상태에서 "안내 종료" 알림이 누락됐다(#1337 evidence). alert push로 전환하면 OS가 직접 banner
 * 를 띄워 killed 상태에서도 즉시 표시된다. running 앱은 OS banner를 보고, BG 핸들러가 `data`
 * payload로 sentinel/dedup을 처리한다(디바이스 PR2 #1338).
 *
 * 헤더/payload:
 *   - apns-push-type: alert  (silent은 background)
 *   - apns-priority: 10      (silent은 5)
 *   - aps.alert: { title, body } + aps.sound: 'default'
 *   - data: { pushId, kind:'trip-ended', tripToken, reason, sentAt }
 *
 * dedup은 호출자(KV `tripEndedAlert:{tripToken}` 1h TTL)가 담당 — 같은 trip 종료가 cron
 * 사이클마다 alert로 떠 노이즈가 되는 것을 1회 발사로 막는다.
 */
export interface SendTripEndedAlertPushOptions {
  deviceToken: string;
  pushId: string;
  reason: TripEndedReason;
  sentAt: number;
  /** 종료된 trip의 token — 클라가 현재 ACTIVE_TRIP_KEY와 비교해 race 차단(#868 P1-2). */
  tripToken: string;
  config: ApnsConfig;
  host: string;
  fetchImpl?: typeof fetch;
  now?: number;
}

export async function sendTripEndedAlertPush(
  options: SendTripEndedAlertPushOptions,
): Promise<SendPushResult> {
  const jwt = await buildApnsJwt(options.config, options.now);
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `https://${options.host}/3/device/${options.deviceToken}`;

  const data: TripEndedAlertPushPayload = {
    pushId: options.pushId,
    kind: 'trip-ended',
    tripToken: options.tripToken,
    reason: options.reason,
    sentAt: options.sentAt,
  };

  const body = JSON.stringify({
    aps: {
      alert: { title: TRIP_ENDED_ALERT_TITLE, body: TRIP_ENDED_ALERT_BODY },
      sound: 'default',
    },
    data,
  });

  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      authorization: `bearer ${jwt}`,
      'apns-topic': options.config.bundleId,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'content-type': 'application/json',
    },
    body,
  });

  if (response.ok) return { ok: true, status: response.status };
  return parseApnsError(response);
}

/**
 * Live Activity update/end push (#586 C). ActivityKit Live Activity의 content-state를
 * 갱신하거나 종료한다. 일반 silent/alert push와 헤더가 다르다:
 *   - apns-topic: ${bundleId}.push-type.liveactivity
 *   - apns-push-type: liveactivity
 *   - apns-priority: 10 (기본) — 호출자가 5로 낮춰 비중요 update를 발사할 수 있음
 *
 * payload:
 *   { aps: { timestamp, event: 'update'|'end', 'content-state': {...},
 *            'stale-date'?, 'dismissal-date'? } }
 *
 * deviceToken 자리에는 `Trip.activityPushToken`을 넣는다. 410 응답은 caller가 trip의
 * activityPushToken을 clear하는 신호 (실제 clear는 PR D에서 발사 path와 함께 구현).
 */
export interface LiveActivityContentState {
  [key: string]: unknown;
}

export interface SendLiveActivityUpdateOptions {
  activityToken: string;
  contentState: LiveActivityContentState;
  event: 'update' | 'end';
  /** epoch seconds — APNs가 dedup/순서 보장에 사용. 누락 시 now. */
  timestamp?: number;
  /** epoch seconds — 이 시각 이후 content-state는 stale 표시. */
  staleDate?: number;
  /** epoch seconds — end 이벤트와 함께 보내면 Live Activity가 이 시각에 자동 dismiss. */
  dismissalDate?: number;
  /** APNs priority. 기본 10 (즉시 전송). 5로 보내면 throttle 대상이 됨. */
  priority?: 5 | 10;
  config: ApnsConfig;
  host: string;
  fetchImpl?: typeof fetch;
  now?: number;
}

export async function sendLiveActivityUpdate(
  options: SendLiveActivityUpdateOptions,
): Promise<SendPushResult> {
  const jwt = await buildApnsJwt(options.config, options.now);
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `https://${options.host}/3/device/${options.activityToken}`;
  const nowSec = Math.floor((options.now ?? Date.now()) / 1000);

  const aps: Record<string, unknown> = {
    timestamp: options.timestamp ?? nowSec,
    event: options.event,
    'content-state': options.contentState,
  };
  if (options.staleDate !== undefined) aps['stale-date'] = options.staleDate;
  if (options.dismissalDate !== undefined) aps['dismissal-date'] = options.dismissalDate;

  const body = JSON.stringify({ aps });
  const priority = options.priority ?? 10;

  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      authorization: `bearer ${jwt}`,
      'apns-topic': `${options.config.bundleId}.push-type.liveactivity`,
      'apns-push-type': 'liveactivity',
      'apns-priority': String(priority),
      'content-type': 'application/json',
    },
    body,
  });

  if (response.ok) return { ok: true, status: response.status };
  return parseApnsError(response);
}

/**
 * "탑승했냐?" 푸시 발사 (#819 B 슬라이스).
 *
 * iOS UNNotificationCategory "BOARDING_PROMPT" 액션 [탑승]/[미탑승]을 노출하려면 alert push
 * (apns-push-type: alert, priority 10) + `aps.category` 필드가 필요하다. 일반 silent push와
 * 달리 화면 표시가 핵심 UX. 클라이언트는 payload의 `originStation` / `line` / `tripToken`을
 * 받아 [탑승] 응답 시 arvlCd 우선순위로 trainCode 자동 선택 후 BoardingLock을 생성한다.
 */
export interface SendBoardingPromptPushOptions {
  deviceToken: string;
  pushId: string;
  /** 사용자 표시용 제목 (i18n는 클라가 한다 — 백엔드는 영문 raw 기본). */
  title: string;
  /** 사용자 표시용 본문 — `${line}호선 ${originStation}` 같은 컨텍스트 포함 권장. */
  body: string;
  /** trip 컨텍스트 — 클라이언트가 응답 처리 시 사용. */
  originStation: string;
  line: string;
  tripToken: string;
  sentAt: number;
  config: ApnsConfig;
  host: string;
  fetchImpl?: typeof fetch;
  now?: number;
}

export async function sendBoardingPromptPush(
  options: SendBoardingPromptPushOptions,
): Promise<SendPushResult> {
  const jwt = await buildApnsJwt(options.config, options.now);
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `https://${options.host}/3/device/${options.deviceToken}`;

  const data: BoardingPromptPushPayload = {
    pushId: options.pushId,
    kind: 'boarding-prompt',
    originStation: options.originStation,
    line: options.line,
    tripToken: options.tripToken,
    sentAt: options.sentAt,
  };

  const body = JSON.stringify({
    aps: {
      alert: { title: options.title, body: options.body },
      sound: 'default',
      category: BOARDING_PROMPT_CATEGORY,
    },
    data,
  });

  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      authorization: `bearer ${jwt}`,
      'apns-topic': options.config.bundleId,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'content-type': 'application/json',
    },
    body,
  });

  if (response.ok) return { ok: true, status: response.status };
  return parseApnsError(response);
}

async function parseApnsError(response: Response): Promise<SendPushResult> {
  let reason: string | undefined;
  try {
    const data = (await response.json()) as { reason?: string };
    reason = data?.reason;
  } catch {
    // ignore parse error
  }
  return { ok: false, status: response.status, reason };
}
