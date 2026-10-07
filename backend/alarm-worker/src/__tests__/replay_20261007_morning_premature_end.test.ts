/**
 * #2888 재생 — 2026-10-07 아침 라이드, trip id154(용마산→건대입구 환승→뚝섬, line_list
 * ["7","2"]) 조기 destination-arrived 재현 시도. **검증 전용 — 프로덕션 코드는 수정하지
 * 않는다.**
 *
 * D1 실측(`events_154.json` + `tripend_all.json`):
 *   - 06:47:26.097 `leg-resolve-attempt` candidates=[] streakCount=0 outcome='none'
 *   - 06:48:28.566 `leg-resolve-attempt` candidates=[{trainCode:'2015',trainSttus:1}]
 *     streakCount=1 outcome='pending' selectedTrainCode='2015'
 *   - 06:48:31.876 `trip-end` station='2-010' reason='destination-arrived'
 * 사용자는 이 시각 건대입구에서 환승 열차 탑승 중이었고(leg-resolve-attempt가 아직 'pending'
 * — 미확정), 목적지 뚝섬까지 2정거장(성수 경유) 남아 있었다. 06:48:28.566~06:48:31.876(약
 * 3.3초) 구간에 `advance`/`cron-fire-attempt`/`vanish-swap` 어느 마커도 없다.
 *
 * ## 1부 — 재현 가능한 부분: leg-resolve-attempt 'pending' 자체
 * `evaluateLegBoardingTransition`(`boardingAnchorResolver.ts:272`)을 06:48:28.517 캡처의
 * 실측 realtimePosition(건대입구/2호선, trainNo=2015, trainSttus=1=ARRIVED, recptnDt
 * 06:47:41)으로 호출하면 D1이 기록한 'pending'/'2015'가 그대로 재현된다 — 이 부분은
 * 실측 데이터로 확정 가능하다.
 *
 * ## 2부 — 재현 불가로 판정: 'pending'에서 'destination-arrived'로의 전이
 * `evaluateLegBoardingTransition`의 설계(파일 헤더 "leg 2 연속확증 재설계" 참고)상 'pending'
 * 상태는 **같은 trainCode가 다음 cron 사이클에 DEPARTED로 관측돼야만** 'confirmed'(→ lock
 * 승격)로 전이한다. cron 주기는 `wrangler.toml`의 매 1분 트리거(triggers.crons)이므로,
 * 06:48:28.566의 'pending' 직후 'confirmed' 전이가 일어나려면 최소 다음 cron tick(약 1분
 * 후)까지 기다려야 한다 — 그러나 trip-end는 그로부터 3.3초 뒤에 발생했다. 이 시간차는 다음
 * cron tick을 기다린 결과로 설명되지 않는다.
 *
 * 그렇다고 같은 cron tick 내부에서 다른 경로(`scheduled.ts:5670` lock-active 분기의
 * `waypoint.kind==='destination'` 직행, 또는 `scheduled.ts:6839-6843` lockless intermediate
 * shift가 waypoints를 0으로 소진)가 작동했다고 가정해도, 그 경로로 가려면 이 cycle 안에서
 * trip의 `boardingLock`/`waypoints` 상태가 06:48:28 이전에 이미 어떤 값이었는지가 전제조건인데,
 * **이 trip의 KV 스냅샷을 확보하지 못했다**(D1 이벤트 로그만 있고 KV 상태 덤프는 없음) — 그래서
 * 두 분기 중 어느 쪽이 실행됐는지조차 코드만으로 결정할 수 없다.
 *
 * 결정적으로, 06:48:28.517이 **이 trip의 마지막 device Seoul API 캡처다** — 그 이후(06:48:31.876
 * trip-end 시각 포함) 캡처가 전혀 없다(`caps/` 디렉토리에 17개 파일, 가장 늦은 것이
 * 06:48:28.517). device의 독립적인 foreground 폴링이 trip 종료와 함께 멈췄기 때문으로 보인다 —
 * 즉 **backend cron이 실제로 무엇을 관측해 destination-arrived를 냈는지 보여주는 실측 입력
 * 자체가 존재하지 않는다.** 합성 데이터로 그 입력을 지어내는 것은 금지됐으므로(과제 지시),
 * 이 전이는 현재 보유한 fixture로는 재현 불가로 판정한다.
 */
import { describe, expect, it } from 'vitest';
import { evaluateLegBoardingTransition } from '../boardingAnchorResolver';
import { SeoulArrivalClient } from '../seoul';
import capLast from './fixtures/replay_20261007_morning_premature_end/caps/1791323308517.json';

/** 실측: 06:48:28.566 KST `leg-resolve-attempt` D1 이벤트 ts (id154). */
const RESOLVE_ATTEMPT_MS = 1_791_323_308_566;
/** 실측: 06:48:31.876 KST `trip-end(destination-arrived)` D1 이벤트 ts (id154, tripend_all.json id851). */
const TRIP_END_MS = 1_791_323_311_876;
/** 마지막 device Seoul API 캡처 시각(이 trip의 `caps/` 디렉토리 17개 중 최댓값). */
const LAST_CAPTURE_MS = 1_791_323_308_517;

interface RawCaptureEntry {
  tMs: number;
  kind: string;
  target: string;
  status: number;
  body: string;
}

function findPositionEntry(cap: { entries: RawCaptureEntry[] }, target: string): RawCaptureEntry {
  const entry = cap.entries.find((e) => e.kind === 'position' && e.target === target);
  if (!entry) throw new Error(`fixture에 position/${target} entry가 없습니다`);
  return entry;
}

function fetchImplForBody(body: string): typeof fetch {
  return (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
}

describe('#2888 재생 — 10/7 아침 id154 조기 destination-arrived', () => {
  it('[재현O, 1부] 06:48:28 캡처로 leg-resolve-attempt를 재현한다 — pending/2015/streak1', async () => {
    const entry = findPositionEntry(capLast, '2호선');
    const body = JSON.parse(entry.body) as {
      realtimePositionList: Array<{ statnNm: string; trainNo: string; trainSttus: string }>;
    };
    const atGeondae = body.realtimePositionList.filter((e) => e.statnNm === '건대입구');
    expect(atGeondae).toHaveLength(1);
    expect(atGeondae[0].trainNo).toBe('2015');
    expect(atGeondae[0].trainSttus).toBe('1'); // ARRIVED

    const seoul = new SeoulArrivalClient({
      apiKey: 'KEY',
      host: 'seoul.api',
      now: () => RESOLVE_ATTEMPT_MS,
      fetchImpl: fetchImplForBody(entry.body),
    });
    const positions = await seoul.fetchPositions('2');

    // D1 실측(id849): 직전 cycle outcome='none'이었으므로 이번 cycle에 넘어오는 pending은
    // undefined — evaluateLegBoardingTransition이 resolved(ARRIVED 유일 후보)를 'pending'으로
    // 승격하며 firstObservedAt=now를 새로 찍는다(이전 pending 없음).
    const confirmation = evaluateLegBoardingTransition(
      { line: '2', boardingStation: '건대입구', direction: null },
      positions,
      RESOLVE_ATTEMPT_MS,
      undefined,
    );

    expect(confirmation.status).toBe('pending');
    expect(confirmation.status === 'pending' && confirmation.trainCode).toBe('2015');
  });

  it('[재현X, 2부 — 명시] pending→destination-arrived 전이는 현재 fixture로 재현 불가', () => {
    // 사실관계 1: trip-end는 leg-resolve-attempt('pending', 미확정) 직후 3.3초 뒤.
    const gapMs = TRIP_END_MS - RESOLVE_ATTEMPT_MS;
    expect(gapMs).toBeCloseTo(3310, -2);

    // 사실관계 2: cron 주기(1분)보다 훨씬 짧다 — "다음 cron tick에서 DEPARTED 전이 확증 후
    // confirmed 승격"(evaluateLegBoardingTransition의 유일한 pending→confirmed 경로)으로는
    // 이 간격을 설명할 수 없다.
    const CRON_INTERVAL_MS = 60_000;
    expect(gapMs).toBeLessThan(CRON_INTERVAL_MS);

    // 사실관계 3: 이 trip의 마지막 device Seoul API 캡처는 leg-resolve-attempt와 거의 동시각
    // (06:48:28.517)이고, trip-end 시각(06:48:31.876)을 포함해 그 이후 캡처는 전무하다 —
    // backend cron이 그 3.3초 동안 실제로 무엇을 관측했는지 보여주는 실측 입력이 없다.
    expect(LAST_CAPTURE_MS).toBeLessThan(TRIP_END_MS);
    expect(TRIP_END_MS - LAST_CAPTURE_MS).toBeCloseTo(3359, -2);

    // 결론(코드 주석이 아니라 이 assert 자체가 결론): 현재 보유한 fixture(D1 이벤트 로그 +
    // device 캡처)만으로는 destination-arrived 전이를 일으킨 입력을 재구성할 수 없다 —
    // KV trip 스냅샷 부재 + 해당 구간 Seoul API 캡처 부재. 합성 입력으로 재현을 강행하지
    // 않는다(과제 지시 — 재현 실패도 결과). 원인은 미확정 상태로 유지된다.
  });
});
