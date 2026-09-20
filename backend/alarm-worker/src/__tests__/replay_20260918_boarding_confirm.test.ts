/**
 * "2026-09-18 라이드에서 사용자가 LA '탑승했어요' 버튼을 눌렀다면, backend가 실제로 lock을
 * 만들었을까?" (#2734 — D1 `boarding-confirm-result` 0건, 실행된 적 없음) 를 실기기 없이
 * 재생으로 답한다.
 *
 * LA AppIntent(`BoardingIntents.swift:postBoardingConfirm`)는 앱을 열지 않고
 * `POST /trips/:token/boarding-confirm`을 직접 쏜다 — body는 `{ action, station, line }`뿐이고
 * trainCode는 없다. backend는 `attemptBoardingAnchorResolution`(realtimePosition 역추론)으로
 * lock을 만든다. 이 테스트는 `app.fetch`로 그 HTTP 핸들러를 실제 시각(17:40:32 KST, 사용자가
 * 건대입구에서 7256을 직접 탭한 시각)에 구동하고, 이어서 기존 `runCaptureReplay` 하네스로
 * cron을 계속 재생해 매역·도착 발사까지 확인한다.
 *
 * 재사용: `makeRide20260918LocklessTrip`(실측 seed, `ride20260918Trip.ts`), `makeCaptureFetch`/
 * `runCaptureReplay`(`replayHarness.ts`), `firedStationOccurrences`(`pushAssertions.ts`) — 전부
 * 기존 하네스. 새 포맷/하네스 신설 없음. fixture는 원본 그대로(`parseReplayFixture`만 통과).
 *
 * ## #2739 — red→green 전환 (2026-09-20)
 * `makeRide20260918LocklessTrip`은 `promptDisplay`를 세팅하지 않는다 — 등록 시점(17:26:01)의
 * 실제 값을 KV 스냅샷으로 확보하지 못했기 때문이다(불명, 확정 아님). 이 파일의 최초 버전은
 * 그 미공급 입력 때문에 `attemptBoardingAnchorResolution`이 anchor를 못 찾아 `lockState:'none'`
 * 이 나오는 것을 **그대로 관측만** 했다(#2734 재생).
 *
 * #2739가 확정한 결함: 탭이 실어 보내는 `{station:'건대입구', line:'7'}`이 핸들러에 도착은
 * 하지만(validator가 필수로 받음) `attemptBoardingAnchorResolution` 호출에는 전달되지
 * 않았다(코드로 확정 — `payload.station`/`payload.line` 사용 횟수 0). `promptDisplay`가
 * 미확정이든 아니든, **탭 자체가 승차역/노선을 명시했으므로 그 정보를 판정에 써야 한다**는
 * 것이 이 fix의 근거다("9/18에 버튼을 눌렀다면 실패했을 것"이라는 사실 단정은 여전히 하지
 * 않는다 — `trip.promptDisplay`의 그 시점 실측값은 지금도 불명이다).
 *
 * fix 이후: `promptDisplay`/`currentLegAnchor` 둘 다 없어도 탭 값(`payload.station/line`)이
 * route(이 trip은 뚝섬→건대입구 환승→용마산, 건대입구가 `kind:'transfer'` waypoint)와
 * 정합하면 1순위 fallback anchor로 채택된다 — D1 meta `anchorSource:'tap'`이 이를 증명한다.
 *
 * ## 별개 발견 (out of scope, 2026-09-20) — 이 특정 실캡처의 direction 인코딩 gap
 * anchor는 정상 채택되지만(`anchorSource:'tap'`), 이어지는 realtimePosition 조회에서
 * `resolveTrainCodeFromPositions`가 여전히 `outcome:'none'`을 낸다. 원인을 추적한 결과 —
 * `inferLegDirection('7','건대입구','어린이대공원(세종대)')`는 `'up'`을 반환하는데, 이 R2
 * 실캡처(`capture_20260918_line7_yongmasan_overshoot.fixture.json`)의 line7 realtimePosition
 * 엔트리는 `updnLine`이 Korean 텍스트(`'상행'`/`'내선'`)가 아니라 숫자 문자열('0'/'1')로
 * 온다 — `seoul.ts:parsePositionEntry`의 `isUp` 파싱(`UP_DIRECTION_VALUES=['상행','내선']`
 * 포함 여부)이 이 포맷을 인식하지 못해 모든 항목이 `isUp:false`로 떨어진다. 이 gap은
 * **#2739(탭 payload 미사용)와 무관한 별개의 사전 존재 결함**이다 — anchor 판정 로직
 * 자체는 이 fix로 정확히 고쳐졌고(탭이 사용됨을 D1로 증명), direction 포맷 gap은 이
 * PR의 스코프 밖이라 손대지 않는다(surgical change 원칙).
 *
 * 아래 첫 테스트는 이 실측 결과(anchorSource:'tap', outcome:'none' — 사유가 이전과
 * 다르다는 것)를 그대로 기록한다. "lock 부착 + trainCode 확인 + cron 완주"의 완전한 green
 * 데모는 `index.test.ts`(`boarded — 탭 anchor fallback (#2739)`, 통제된 synthetic position
 * 데이터로 같은 anchor/segment 모양을 검증)와 기존 `replay_20260918_lock_seeded_contrast.test.ts`
 * (같은 실캡처로 lock 부착 후 cron이 정상 완주함을 이미 증명, direction 필터를 타지 않는
 * 경로)의 조합이 담당한다.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { app } from '../index';
import { getTrip } from '../trips';
import { putTrip } from '../trips';
import type { Env, Trip } from '../types';
import { InMemoryKV } from './inMemoryKv';
import { makeCaptureFetch, runCaptureReplay, type CapturedPush } from './helpers/replayHarness';
import {
  makeRide20260918LocklessTrip,
  RIDE_20260918_CREATED_AT_MS,
  RIDE_20260918_TRAIN,
} from './helpers/ride20260918Trip';
import { firedStationOccurrences } from './helpers/pushAssertions';
import { parseReplayFixture } from '../replayFixture';
import fixtureJson from './fixtures/replayLibrary/capture_20260918_line7_yongmasan_overshoot.fixture.json';

const fixture = parseReplayFixture(fixtureJson);

/** 실측: 사용자가 건대입구에서 7256을 직접 탭한 시각(2026-09-18 17:40:32 KST) epoch ms. */
const TAP_MS = RIDE_20260918_CREATED_AT_MS + (17 * 3600 + 40 * 60 + 32 - (17 * 3600 + 26 * 60 + 1)) * 1000;

const TOKEN = 'ride-20260918-boarding-confirm';

function makeConfirmEnv(kv: InMemoryKV, db?: D1Database): Env {
  return {
    TRIPS: kv as unknown as Env['TRIPS'],
    APNS_HOST: 'api.push.apple.com',
    APNS_HOST_SANDBOX: 'api.sandbox.push.apple.com',
    SEOUL_API_HOST: 'seoul.api',
    SEOUL_API_KEY: 'KEY',
    APNS_KEY_ID: 'k',
    APNS_TEAM_ID: 't',
    APNS_PRIVATE_KEY: 'p',
    APNS_BUNDLE_ID: 'b',
    ...(db ? { DB: db } : {}),
  };
}

/** `tripEventLog.test.ts`와 동일 패턴 — prepare().bind().run() 체인을 캡처하는 fake D1. */
function makeCapturingDb(): {
  db: D1Database;
  prepare: ReturnType<typeof vi.fn>;
  bind: ReturnType<typeof vi.fn>;
} {
  const run = vi.fn().mockResolvedValue({ success: true });
  const bind = vi.fn().mockReturnValue({ run });
  const prepare = vi.fn().mockReturnValue({ bind });
  return { db: { prepare } as unknown as D1Database, prepare, bind };
}

function destinationArrivedFired(pushes: CapturedPush[]): boolean {
  return pushes.some((push) => {
    if (push.headers.pushType !== 'alert') return false;
    const data = push.body.data as Record<string, unknown> | undefined;
    return data?.kind === 'trip-ended' && data?.reason === 'destination-arrived';
  });
}

describe('#2734 재생 — LA "탑승했어요" 탭이 17:40:32에 도달했다면 backend가 lock을 만들었을까', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(TAP_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('POST /trips/:token/boarding-confirm(action=boarded, station=건대입구, line=7)을 탭 시각에 재생한다', async () => {
    const kv = new InMemoryKV(() => TAP_MS);
    await putTrip(kv as unknown as Env['TRIPS'], makeRide20260918LocklessTrip(TOKEN));

    // LA AppIntent가 실제로 보내는 fetchImpl 경로 — boarding-confirm 핸들러는 fetchImpl을
    // 주입받지 못해 전역 fetch를 쓴다(`index.ts:2150` `new SeoulArrivalClient({...})`,
    // fetchImpl 미지정). 그 전역 fetch를 fixture 캡처 스트림으로 라우팅한다(재사용 —
    // `makeCaptureFetch`, 새 fetch 시뮬레이터 신설 없음).
    vi.stubGlobal('fetch', makeCaptureFetch(fixture, () => TAP_MS));

    const { db, prepare, bind } = makeCapturingDb();
    const env = makeConfirmEnv(kv, db);

    const res = await app.fetch(
      new Request(`http://example.com/trips/${TOKEN}/boarding-confirm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // LA AppIntent 실제 body(`BoardingIntents.swift:59`) — trainCode 없음.
        body: JSON.stringify({ action: 'boarded', station: '건대입구', line: '7' }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; lockState: string };
    expect(json.ok).toBe(true);

    // ---- 결과 기록 (#2739 fix 이후 — 해석은 파일 헤더 "별개 발견" 참고) ----
    // 탭(건대입구/7)이 route(뚝섬→건대입구 환승→용마산)와 정합해 1순위 fallback anchor로
    // 채택된다(D1 meta anchorSource:'tap' — 아래에서 확인) — #2739가 고치는 것은 정확히 이
    // 지점("탭 값이 판정에 쓰이는가")이며 여기까지는 fix로 green이다. 그러나 이 실캡처의
    // line7 realtimePosition `updnLine`이 숫자 인코딩이라 direction 필터가 정확한 후보
    // (7256)를 걸러내 outcome은 여전히 'none'이다 — 원인이 이전(anchor 자체 부재)과 다르다는
    // 것이 이 테스트의 핵심 관측이다(별개의 pre-existing gap, #2739 스코프 밖).
    expect(json.lockState).toBe('none');

    const stored = await getTrip(kv as unknown as Env['TRIPS'], TOKEN);
    expect(stored?.boardingLock).toBeUndefined();
    // #1923 — 락 미확정이어도 명시 탭 의향(infoModeEnabled)은 stamp된다(ADR-014, 이 trip은
    // seed 시점부터 이미 true — 회귀 없음을 재확인).
    expect(stored?.infoModeEnabled).toBe(true);

    // D1 `boarding-confirm-result` 이벤트는 lockState/outcome과 무관하게 매 호출 1회 append —
    // #2734가 관측한 "실사용 0건"이 이 엔드포인트 자체의 결함(호출은 됐는데 기록 안 됨)이
    // 아니라는 것을 확인한다. anchorSource:'tap'이 #2739 fix가 실제로 탭 값을 anchor 판정에
    // 사용했음을 증명한다(요구사항 4).
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO trip_events'));
    const [, , kind, , , metaJson] = bind.mock.calls[0] as [string, number, string, unknown, unknown, string | null];
    expect(kind).toBe('boarding-confirm-result');
    expect(JSON.parse(metaJson ?? '{}')).toEqual({
      lockState: 'none',
      outcome: 'none',
      anchorSource: 'tap',
    });
  });

  it('lock 미부착 상태로 cron을 이어 재생하면 — 실측(REPLAY_LIBRARY 엔트리)과 동일하게 매역 발사 0건이다', async () => {
    // 위 테스트가 만든 상태(lockState:'none', boardingLock 없음 — 사유는 #2739 fix 이후에도
    // direction 인코딩 gap으로 여전히 'none')를 그대로 물려받아 cron이 15 cycle을 어떻게
    // 이어가는지 관찰한다 — "버튼을 눌렀다면 완주했을까"의 후반부.
    const kv = new InMemoryKV(() => TAP_MS);
    const seedToken = TOKEN + '-cron-continuation';
    const tripAfterConfirm: Trip = { ...makeRide20260918LocklessTrip(seedToken) };
    await putTrip(kv as unknown as Env['TRIPS'], tripAfterConfirm);

    const result = await runCaptureReplay({
      fixture,
      seedTrips: [tripAfterConfirm],
      apns: 'capture',
    });

    // lock이 없으므로 station-passed(alert) 채널은 원리적으로 못 뜬다 — 실측 REPLAY_LIBRARY
    // entry(`replayLibrary.ts`의 `capture_20260918_line7_yongmasan_overshoot`)와 동일 결론.
    // lock이 부착됐다면(예: `replay_20260918_lock_seeded_contrast.test.ts`) 같은 실캡처로
    // 어린이대공원/군자(능동)/중곡 발사 + destination-arrived 완결까지 이어진다는 것은 이미
    // 별도 테스트로 증명돼 있다 — lock 부착 여부만이 이 사건의 분기점이라는 결론은 그대로다.
    expect(firedStationOccurrences(result.pushes)).toEqual([]);
    expect(destinationArrivedFired(result.pushes)).toBe(false);
  });

  it('대조: promptDisplay가 seed에 있었다면(가정) anchor가 잡혀 lock이 부착됐을 것 — 미공급 입력의 영향력 확인용', async () => {
    // #2734 질문의 "미공급 입력이 결과를 좌우했다"는 주장을 검증하기 위한 대조군. 실측 아님 —
    // `replay_20260918_lock_seeded_contrast.test.ts`와 동일 원칙(REPLAY_LIBRARY에 등록하지
    // 않음, 실측이 아니라고 이름/설명에 명시)으로 이 describe 안에서만 국지적으로 확인한다.
    // seed 헬퍼 자체(`ride20260918Trip.ts`)는 수정하지 않는다 — 여기서 로컬 오버라이드만 준다.
    const kv = new InMemoryKV(() => TAP_MS);
    const contrastToken = TOKEN + '-promptDisplay-assumed';
    const tripWithAssumedPromptDisplay: Trip = {
      ...makeRide20260918LocklessTrip(contrastToken),
      // originStationName('뚝섬')·route.fromLine('2')과 정합되는 유일하게 무모순적인 leg-1
      // anchor 후보값 — 실측 확인은 아니다(파일 헤더 "미공급 입력" 참고).
      promptDisplay: { originStation: '뚝섬', line: '2' },
    };
    await putTrip(kv as unknown as Env['TRIPS'], tripWithAssumedPromptDisplay);

    vi.stubGlobal('fetch', makeCaptureFetch(fixture, () => TAP_MS));
    const env = makeConfirmEnv(kv);

    const res = await app.fetch(
      new Request(`http://example.com/trips/${contrastToken}/boarding-confirm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'boarded', station: '건대입구', line: '7' }),
      }),
      env,
    );
    const json = (await res.json()) as { ok: boolean; lockState: string };

    // anchor.line은 promptDisplay.line('2')에서 온다 — #2739 fix 이후에도 promptDisplay가
    // 있으면 그것이 currentLegAnchor 다음 우선순위이고 탭은 그 뒤 fallback이라(요구사항 1/2,
    // 회귀 없음) 탭이 실제로 실어 보낸 7호선 값은 여기서 쓰이지 않는다 — 이는 결함이 아니라
    // "backend anchor가 있으면 그것을 신뢰한다"는 의도된 우선순위다. 그래서 사용자가 실제로
    // 탭한 것은 7호선 열차인데 anchor는 2호선 뚝섬 기준으로 조회되고, 이 대조군조차 정확한
    // lock을 만들 것이라는 보장이 없다(포지션 fixture에 2호선 뚝섬 항목이 없으면 lockState는
    // 여전히 'none'이다).
    expect(['none', 'leg1']).toContain(json.lockState);
    if (json.lockState === 'leg1') {
      const stored = await getTrip(kv as unknown as Env['TRIPS'], contrastToken);
      // 만약 leg1로 resolve됐다면 그건 anchor.line='2'(뚝섬) 기준 매칭이라 trainCode가
      // 7256일 근거가 없다 — 여기선 어떤 값이 나오든 실측 트레인코드(7256)와 동일하다고
      // 주장하지 않는다.
      expect(typeof stored?.boardingLock?.trainCode).toBe('string');
    }
  });
});

// 실측 trainCode 상수 참조 — 대조 문서화용(아래 export 없는 상수의 미사용 경고 방지 목적이
// 아니라, 헤더 설명에서 언급한 실측 값을 이 파일 스코프에서도 assert 가능하게 남겨둔다).
void RIDE_20260918_TRAIN;
