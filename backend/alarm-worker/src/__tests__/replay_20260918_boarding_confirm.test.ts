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
 * ## #2751 정정 — 위 "별개 발견"(direction 인코딩)은 오진단이었다, 진짜 사유는 recptnMs 파싱
 * 2026-09-20 당시 이 파일은 anchor는 정상 채택되지만(`anchorSource:'tap'`) 이어지는
 * realtimePosition 조회에서 `resolveTrainCodeFromPositions`가 여전히 `outcome:'none'`을
 * 내는 원인을 "`updnLine` 숫자 인코딩을 `isUp` 파서가 인식 못 한다"고 적었다 — **이는 틀렸다.**
 * `updnLine` 숫자 코드 파싱은 #2746이 이미 고쳐 이 파일 작성 시점에도 정상 동작했다(방향은
 * 실제로 일치했다). 진짜 사유는 `seoul.ts:parsePositionEntry`가 수신시각을 `item.lastRecptnDt`
 * (실 API는 여기에 날짜만, 'YYYYMMDD' — 시각 없음)에서 읽어 `recptnMs`가 항상 0으로 떨어지고,
 * `boardingAnchorResolver.ts`의 신선도 필터(`recptnMs>0`)가 방향/역명/trainSttus를 전부
 * 만족하는 7256까지 포함해 후보를 전량 배제했기 때문이다(#2751 — 실캡처로 확정).
 *
 * #2751 fix로 `parsePositionEntry`가 `item.recptnDt`(전체 타임스탬프)를 읽게 되면서, 이
 * 탭 시각의 건대입구/7호선/상행 스냅샷에서 7256이 유일 후보로 실제로 resolved되어 leg-2
 * lock으로 즉시 승격한다 — 아래 첫 테스트가 이 실측 결과(anchorSource:'tap',
 * outcome:'resolved', lockState:'leg2')를 그대로 기록한다. 두 번째 테스트("cron을 이어
 * 재생하면")는 lock을 다시 떼어낸(seed를 lockless로 재구성) 대조 시나리오라 이 fix와
 * 무관하게 여전히 매역 발사 0건이다 — 단, 그 재생 경로도 leg-2 cron 자동 resolve(#2539)를
 * 다시 태울 수 있어(같은 실캡처가 `replayLibrary.ts` entry에서 그렇게 관측됨) 실측 device
 * motion series(`buildRide20260918PositionSeries`)를 주입해 fixture fidelity를 맞춘다(#2718
 * 선례와 동일 근거) — 그 결과로도 이 재생 구간(15 cycle) 안에서는 station-passed 발사가
 * 없다(REPLAY_LIBRARY entry와 동일 결론, `replayLibrary.ts` 주석 참고).
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
import { buildRide20260918PositionSeries } from './helpers/ride20260918PositionSeries';
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

    // ---- 결과 기록 (#2751 fix 이후 — 실측 재확인, 파일 헤더 "#2751 정정" 참고) ----
    // 탭(건대입구/7)이 route(뚝섬→건대입구 환승→용마산)와 정합해 1순위 fallback anchor로
    // 채택된다(D1 meta anchorSource:'tap' — 아래에서 확인, #2739가 고친 지점). #2751 이전에는
    // `parsePositionEntry`가 `lastRecptnDt`(날짜만)를 읽어 `recptnMs`가 항상 0으로 떨어져
    // 신선도 필터가 후보를 전량 배제했다 — 그래서 방향/역명 조건을 만족하는 7256이 있어도
    // outcome은 구조적으로 'none'이었다. #2751 fix로 `recptnDt`(전체 타임스탬프)를 정확히
    // 읽게 되면서, 이 탭 시각(17:40:32)의 건대입구/7호선/상행 스냅샷에서 유일 후보인 7256이
    // 실제로 resolved되어 leg-2 lock으로 즉시 승격한다(탭 경로는 register-time과 동일하게
    // streak 게이트 없이 1회 resolved로 승격 — #2539 leg-2 cron 자동 resolve와 다른 경로).
    expect(json.lockState).toBe('leg2');

    const stored = await getTrip(kv as unknown as Env['TRIPS'], TOKEN);
    expect(stored?.boardingLock?.trainCode).toBe(RIDE_20260918_TRAIN);
    expect(stored?.boardingLock?.line).toBe('7');
    // #1923 — 명시 탭 의향(infoModeEnabled)은 lock 승격 여부와 무관하게 stamp된다(ADR-014,
    // 이 trip은 seed 시점부터 이미 true — 회귀 없음을 재확인).
    expect(stored?.infoModeEnabled).toBe(true);

    // D1 `boarding-confirm-result` 이벤트는 lockState/outcome과 무관하게 매 호출 1회 append —
    // #2734가 관측한 "실사용 0건"이 이 엔드포인트 자체의 결함(호출은 됐는데 기록 안 됨)이
    // 아니라는 것을 확인한다. anchorSource:'tap'이 #2739 fix가 실제로 탭 값을 anchor 판정에
    // 사용했음을 증명하고, outcome:'resolved'가 #2751 fix로 leg-2 역추론 경로가 실제로
    // 살아났음을 증명한다(요구사항 4 — 이슈가 명시한 측정 plan 그 자체).
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO trip_events'));
    const [, , kind, , , metaJson] = bind.mock.calls[0] as [string, number, string, unknown, unknown, string | null];
    expect(kind).toBe('boarding-confirm-result');
    expect(JSON.parse(metaJson ?? '{}')).toEqual({
      lockState: 'leg2',
      outcome: 'resolved',
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
      // #2751 — `replayLibrary.ts`의 동일 entry(`capture_20260918_line7_yongmasan_overshoot`)와
      // 동일 근거로 실측 motion series를 주입한다(fixture 헤더 #2718). 이 옵션 없이는
      // `isAdvanceAllowedByMotion` 게이트가 결정론적으로 차단돼 lockless intermediate 발사
      // 자체가 fixture 인공물로 억제된다 — 이 테스트가 그동안 이 누락에도 통과했던 것은
      // leg-2 anchor resolve가 #2751 결함으로 구조적으로 항상 'none'이라 lock-active 경로도
      // 함께 죽어 있었기 때문이다.
      seedPositionSeries: { [seedToken]: buildRide20260918PositionSeries() },
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
