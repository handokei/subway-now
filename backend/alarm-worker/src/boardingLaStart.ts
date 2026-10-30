/**
 * #3221 PR-3 — 탑승여부 Live Activity(`BoardingActivityAttributes`) **push-to-start** 발사기.
 *
 * 탑승 질문(탑승/하차/종료 제안)은 여정 LA(`SubwayActivityAttributes`)와 별도 ActivityKit 타입의 LA로 띄운다
 * (ADR-051). 질문 시점은 대부분 앱이 꺼진 BG cron이고 기기는 BG에서 LA를 시작할 수 없어(plan F17) iOS 17.2+
 * push-to-start가 주 경로다. 대상은 update token이 아니라 기기 단위 push-to-start token(`Trip.boardingPushToStartToken`).
 *
 * 발사 게이트는 `hasBoardingStartTarget` 하나: `laClient.split && boardingPushToStartToken`. 이 조건이 아니면
 * 호출부는 현행 경로(여정 LA content에 질문 spread + 일반 알림)를 그대로 쓴다 — 구 클라이언트 byte 동일.
 *
 * 종료는 기기 소유(응답 intent / lock / cleanup)라 backend는 탑승 LA update token을 저장하지 않는다(KV 쓰기 +0, R-a).
 * 관측은 D1 `trip_events` kind `la-boarding-start`(path, phase, status) — 이것도 KV를 쓰지 않는다.
 */
import { BOARDING_PROMPT_SOUND, sendLiveActivityStart, type LiveActivityContentState } from './apns';
import { sendWithEnvHeal } from './apnsHost';
import { isApnsTokenInvalid, type LiveActivityDeps } from './liveActivity';
import { LINE_META } from './lineAlias';
import { hashTripToken } from './sentry';
import { recordTripEvent } from './tripEventLog';
import type { Env, Trip } from './types';

/** Swift `BoardingActivityAttributes`의 타입명 — APNs `attributes-type`. 위젯 MIRROR 파일과 일치해야 한다. */
export const BOARDING_ACTIVITY_ATTRIBUTES_TYPE = 'BoardingActivityAttributes';

/** Swift ContentState `phase`. 데이터 주도 — 신규 질문 종류는 여기에만 추가. */
export type BoardingLaPhase = 'pre-boarding' | 'hop-end' | 'end-prompt';

/** 발사 호출 지점(D1 meta.path). 질문 1종류 = 호출 지점 1개. */
export type BoardingLaStartPath = 'boarding-prompt' | 'hop-end-prompt' | 'end-prompt-due';

type Logger = (message: string, meta?: Record<string, unknown>) => void;

/** push-to-start를 쏠 수 있는 trip인가 (`laClient.split` + 기기가 등록한 push-to-start token). */
export function hasBoardingStartTarget(trip: Trip): boolean {
  return trip.laClient?.split === true && Boolean(trip.boardingPushToStartToken);
}

export interface FireBoardingLaStartInputs {
  trip: Trip;
  env: Pick<Env, 'DB'>;
  deps: LiveActivityDeps;
  now: number;
  log: Logger;
  path: BoardingLaStartPath;
  phase: BoardingLaPhase;
  /** 질문 대상 역(탑승=출발역, 하차=환승역, 종료 제안=현재역). */
  station: string;
  /** `Waypoint.line` 코드("7"). 표시용 노선명/색은 `LINE_META`에서 파생한다. */
  line: string;
  /** hop-end에서 갈아탈 노선 코드. */
  nextLine?: string | null;
  title: string;
  /** 열차 정보 한 줄(탑승 질문). */
  trainInfo?: string;
  /** 보조 설명(하차/종료 제안). */
  body?: string;
}

export interface FireBoardingLaStartResult {
  /** APNs가 start를 수락(2xx)했는가 — 호출부가 일반 알림 무음 여부를 정한다(#3146 기준). */
  sent: boolean;
  /** trip(apnsEnv 정정 / 죽은 token 제거)이 바뀌어 호출부가 putTrip해야 하는가. */
  dirty: boolean;
}

function canonicalLineName(line: string): string {
  return LINE_META[line]?.canonical ?? line;
}

function buildBoardingContentState(inputs: FireBoardingLaStartInputs): LiveActivityContentState {
  const { phase, station, line, nextLine, title, trainInfo, body } = inputs;
  const lineName = canonicalLineName(line);
  return {
    phase,
    originStation: station,
    line: lineName,
    lineName,
    // LINE_META에 없는 신규 노선 코드도 non-optional 필드가 비지 않게 중립색 fallback(buildLiveActivityContentState와 동일).
    lineColorHex: LINE_META[line]?.color ?? '#888888',
    title,
    ...(trainInfo === undefined ? {} : { trainInfo }),
    ...(body === undefined ? {} : { body }),
    ...(nextLine ? { nextLine: canonicalLineName(nextLine) } : {}),
  };
}

/**
 * 탑승 LA start 1건 발사. 실패는 삼키고(예외 없음) `sent=false`로 돌려준다 — 호출부는 일반 알림 소리를 유지한다.
 * 죽은 token(410 / 양쪽 env BadDeviceToken)은 비워서 다음 질문이 같은 죽은 token으로 헛발사하지 않게 한다(register가 다시 채움).
 */
export async function fireBoardingLaStart(inputs: FireBoardingLaStartInputs): Promise<FireBoardingLaStartResult> {
  const { trip, env, deps, now, log, path, phase, station, line, title } = inputs;
  const pushToStartToken = trip.boardingPushToStartToken;
  if (!hasBoardingStartTarget(trip) || !pushToStartToken) return { sent: false, dirty: false };

  const contentState = buildBoardingContentState(inputs);
  const body = inputs.trainInfo ?? inputs.body ?? '';
  const heal = await sendWithEnvHeal(
    (host) =>
      sendLiveActivityStart({
        pushToStartToken,
        attributesType: BOARDING_ACTIVITY_ATTRIBUTES_TYPE,
        // 재질문은 새 promptId — 같은 id면 기기가 중복 시작으로 보고 no-op 처리한다.
        attributes: { promptId: `${phase}-${now}`, tripToken: trip.token },
        contentState,
        alert: { title, body, sound: BOARDING_PROMPT_SOUND },
        config: deps.apnsConfig,
        host,
        fetchImpl: deps.fetchImpl,
        now,
      }),
    trip.apnsEnv,
    deps.apnsHosts,
    log,
    trip.token.slice(0, 8),
  );
  const { result } = heal;
  let dirty = false;
  if (heal.correctedEnv) {
    trip.apnsEnv = heal.correctedEnv;
    dirty = true;
  }
  if (!result.ok && isApnsTokenInvalid(result.status, result.reason) && (result.status === 410 || heal.envMismatchExhausted)) {
    trip.boardingPushToStartToken = undefined;
    dirty = true;
  }
  if (!result.ok) {
    log('boarding-la-start failed', { token: trip.token.slice(0, 8), phase, status: result.status, reason: result.reason });
  }
  await recordTripEvent(
    env.DB,
    {
      tokenHash: hashTripToken(trip.token),
      kind: 'la-boarding-start',
      station,
      line,
      meta: {
        path,
        phase,
        status: result.status,
        ok: result.ok,
        ...(result.ok || result.reason === undefined ? {} : { reason: result.reason }),
      },
    },
    now,
  );
  return { sent: result.ok, dirty };
}
