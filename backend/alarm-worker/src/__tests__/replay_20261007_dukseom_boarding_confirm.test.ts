/**
 * #2888 재생 — 2026-10-07 저녁 라이드, trip id155(뚝섬→건대입구 환승→용마산, line_list
 * ["2","7"]) 탑승확인 실패 재현. **검증 전용 — 프로덕션 코드는 수정하지 않는다.**
 *
 * D1 실측(`events_155.json`): 사용자가 뚝섬에서 2호선 탑승 직후 19:23:36(KST)에 LA "탑승
 * 했어요"를 눌렀고, backend(`POST /trips/:token/boarding-confirm`)는 19:23:37.563에
 * `boarding-confirm-result {lockState:'none', outcome:'none', anchorSource:'promptDisplay'}`
 * 로 응답했다 — anchorSource가 'promptDisplay'라는 것은 `resolveActiveLegOrigin`이
 * `trip.promptDisplay`({originStation:'뚝섬', line:'2'})를 anchor로 채택했다는 뜻이고(leg 1,
 * `currentLegAnchor` 없음), outcome:'none'은 `attemptBoardingAnchorResolution`이 그 anchor로
 * realtimePosition을 조회했지만 `resolveTrainCodeFromPositions`가 0개 후보로 떨어졌다는 뜻이다
 * (`boardingAnchorResolver.ts:478-585`).
 *
 * waypoints는 같은 이벤트 로그의 `route-signature-mismatch`(ts 1791368619103, confirm 2초 뒤,
 * advance 전 최초 관측)가 남긴 `existingSig`를 그대로 옮겼다 —
 * "성수|2|intermediate|0/건대입구|2|transfer|0/어린이대공원(세종대)|7|intermediate|0/
 * 군자(능동)|7|intermediate|0/중곡|7|intermediate|0/용마산|7|destination|0".
 *
 * ## 재현 방법
 * 이 저장소의 재생 하네스(`makeCaptureFetch`)는 freshMs=20s 창으로 "지금 시각 기준 가장 최근
 * entry"만 고른다 — 그러나 이 trip의 실측 device 캡처(`caps/*.json`, 독립적인 디바이스
 * foreground 폴링 cron)는 confirm 시각(19:23:37.563)을 20s 이내로 브라케팅하지 못한다(가장
 * 가까운 이전 캡처가 19:22:29 = confirm보다 68초 전, 가장 가까운 이후 캡처가 19:24:30 = 53초
 * 후). freshMs를 인위적으로 넓히면 "그 순간 backend가 무엇을 봤는가"가 아니라 "device가 어쩌다
 * 포착한 가장 가까운 스냅샷"을 섞는 것이므로, 이 파일은 하네스의 fetch 레이어를 거치지 않고
 * `SeoulArrivalClient`에 `fetchImpl`을 직접 주입해 **각 캡처의 raw body를 그대로**(파싱 로직은
 * 실제 `seoul.ts:parsePositionEntry` 그대로) `attemptBoardingAnchorResolution`에 흘려보낸다 —
 * "이 시각에 가장 가까이 있던 실측 스냅샷을 backend가 봤다면"을 두 방향(직전/직후)에서 각각
 * 질문한다.
 *
 * ## 결론 교정 (2026-10-07, 코디네이터 지적 반영)
 * 최초 버전은 "DEPARTED(2)를 후보로 인정했다면 뚝섬의 유일 후보(trainNo 8425)가 resolved됐을
 * 것"이라고 결론 냈으나, **8425는 `updnLine='1'`(외선/하행)로 사용자 진행 방향(뚝섬→성수→
 * 건대입구 = 내선/상행)과 반대 열차다.** 프로덕션은 anchor 매칭에 direction을 null로 두지
 * 않는다 — `boardingAnchorResolver.ts:534-538`이 `inferLegDirection(anchor.line,
 * anchor.originStation, nextWaypoint.stationName)`로 매 호출마다 방향을 계산해 후보를 거른다.
 * 이 trip은 `inferLegDirection('2','뚝섬','성수') === 'up'`이므로, 방향 필터를 production과
 * 동일하게 적용하면 8425는 애초에 후보 풀에도 들어오지 못한다 — **DEPARTED를 받아들이는 것만
 * 으로는 해결되지 않는다.**
 *
 * 진짜 root는 "DEPARTED 배제"가 아니라 **"확인 시점에 사용자 열차가 이미 앵커 역(뚝섬)을 떠나
 * 있다"**는 것이다. 같은 캡처(19:24:30)에서 사용자가 실제로 타고 있었을 열차는 `trainNo 6408`
 * (`updnLine='0'`=내선=방향 일치, `statnNm='성수'`=뚝섬 기준 진행방향 1-hop 전방, `trainSttus=2`
 * =DEPARTED)다 — 앵커 역 "정위치" 매칭이 아니라 **앵커 기준 진행방향 ±N hop 창 + 방향 일치**로
 * 후보를 잡아야 유일하게 잡힌다. 이 패턴은 이미 `arrivalsFromPositions.ts:52-61`(#2875, vanish
 * swap 후보창 확장)가 쓰고 있는 것과 동일하다 — 해법 방향은 **그 패턴을 confirm anchor 경로에도
 * 적용**하는 것이고, 방향 필터는 반드시 유지해야 한다(없애면 반대 방향 열차를 lock하는 새
 * 회귀가 생긴다).
 */
import { describe, expect, it } from 'vitest';
import { attemptBoardingAnchorResolution, resolveTrainCodeFromPositions } from '../boardingAnchorResolver';
import { SeoulArrivalClient, type PositionEntry } from '../seoul';
import { TRAIN_STATUS } from '../alarm';
import { inferLegDirection } from '../legDirection';
import type { Trip, Waypoint } from '../types';
import capBefore from './fixtures/replay_20261007_evening_boarding_confirm/caps/1791368549325.json';
import capAfter from './fixtures/replay_20261007_evening_boarding_confirm/caps/1791368670627.json';

/** 실측: 2026-10-07 19:23:37.563 KST (D1 `boarding-confirm-result` 이벤트 ts, id155). */
const CONFIRM_MS = 1_791_368_617_563;

/** `SeoulCaptureEntry` 축약 타입 — 캡처 raw JSON의 entries[] 원소. */
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

/** 캡처 raw body를 그대로 응답하는 fetchImpl — `seoul.ts` 파싱 경로를 그대로 통과시킨다. */
function fetchImplForBody(body: string): typeof fetch {
  return (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
}

/** D1 실측 route-signature-mismatch(ts 1791368619103, confirm 직후 최초 관측)의 existingSig
 * 그대로 — advance 이전 원본 waypoints. */
const WAYPOINTS: Waypoint[] = [
  { stationName: '성수', line: '2', kind: 'intermediate' },
  { stationName: '건대입구', line: '2', kind: 'transfer' },
  { stationName: '어린이대공원(세종대)', line: '7', kind: 'intermediate' },
  { stationName: '군자(능동)', line: '7', kind: 'intermediate' },
  { stationName: '중곡', line: '7', kind: 'intermediate' },
  { stationName: '용마산', line: '7', kind: 'destination' },
];

function makeTrip(token: string): Trip {
  return {
    token,
    route: { type: 'transfer', transferName: '건대입구', fromLine: '2', toLine: '7', stopsToTransfer: 2, stopsFromTransfer: 4 },
    destination: '용마산',
    waypoints: WAYPOINTS,
    expiresAt: CONFIRM_MS + 60 * 60_000,
    createdAt: CONFIRM_MS - 2 * 60_000,
    alarmAtEpochMs: CONFIRM_MS,
    originStationName: '뚝섬',
    // D1 실측: anchorSource:'promptDisplay' — currentLegAnchor 없음, promptDisplay가 채택됨.
    promptDisplay: { originStation: '뚝섬', line: '2' },
    infoModeEnabled: true,
    boardingLock: undefined,
  };
}

describe('#2888 재생 — 10/7 저녁 id155 탑승확인 실패 (뚝섬/2호선, confirm 19:23:37.563)', () => {
  it('[재현O] confirm 직전(19:22:29) 캡처로 호출 — 뚝섬 position entry 자체가 0개 → none', async () => {
    const entry = findPositionEntry(capBefore, '2호선');
    // 전제 확인(가설 분기 1): 이 캡처 시점엔 2호선 positionList에 뚝섬 항목이 아예 없다 —
    // DEPARTED 제외 게이트와 무관하게 "후보 0개"로 떨어지는 경로.
    const body = JSON.parse(entry.body) as { realtimePositionList: Array<{ statnNm: string }> };
    expect(body.realtimePositionList.some((e) => e.statnNm === '뚝섬')).toBe(false);

    const seoul = new SeoulArrivalClient({
      apiKey: 'KEY',
      host: 'seoul.api',
      now: () => CONFIRM_MS,
      fetchImpl: fetchImplForBody(entry.body),
    });

    let outcome: string | undefined;
    const lock = await attemptBoardingAnchorResolution(
      makeTrip('dukseom-before'),
      seoul,
      CONFIRM_MS,
      { allowLegTransfer: true, tapAnchor: { boardingStation: '뚝섬', line: '2' } },
      (o) => {
        outcome = o;
      },
    );

    // D1 실측과 동일 결과: outcome:'none', lock 미생성.
    expect(outcome).toBe('none');
    expect(lock).toBeNull();
  });

  it('[재현O, 원인 분기 정정] confirm 53초 후(19:24:30) 캡처 — 뚝섬 유일 후보는 반대 방향(DEPARTED 수용해도 후보 0), 사용자 열차는 앵커 1-hop 전방(성수)에 있다', async () => {
    const entry = findPositionEntry(capAfter, '2호선');
    const body = JSON.parse(entry.body) as {
      realtimePositionList: Array<{
        statnNm: string;
        trainSttus: string;
        recptnDt: string;
        trainNo: string;
        updnLine: string;
      }>;
    };
    const dukseomEntries = body.realtimePositionList.filter((e) => e.statnNm === '뚝섬');
    // 전제 확인(가설 분기 2): 이 캡처엔 뚝섬 항목이 정확히 1개 있고, trainSttus='2'(DEPARTED),
    // updnLine='1'(외선/하행) — 사용자 진행 방향(뚝섬→성수→건대입구 = 내선/상행)과 반대다.
    expect(dukseomEntries).toHaveLength(1);
    expect(dukseomEntries[0].trainSttus).toBe('2');
    expect(dukseomEntries[0].trainNo).toBe('8425');
    expect(dukseomEntries[0].updnLine).toBe('1');

    const seoul = new SeoulArrivalClient({
      apiKey: 'KEY',
      host: 'seoul.api',
      // recptnDt(19:23:41)가 "now"보다 미래가 되지 않도록 이 캡처 자체의 fetch 시각을 now로
      // 둔다 — "이 스냅샷을 그대로 봤다면" 질문이므로 신선도 판정도 그 스냅샷 시점 기준.
      now: () => entry.tMs,
      fetchImpl: fetchImplForBody(entry.body),
    });

    let outcome: string | undefined;
    const lock = await attemptBoardingAnchorResolution(
      makeTrip('dukseom-after'),
      seoul,
      entry.tMs,
      { allowLegTransfer: true, tapAnchor: { boardingStation: '뚝섬', line: '2' } },
      (o) => {
        outcome = o;
      },
    );

    // #2892 fix 후: 앵커("뚝섬") 정위치 후보는 여전히 0개(ARRIVED/APPROACHING tier 둘 다 0)지만,
    // 앵커를 진행 방향으로 막 통과한 1-hop 전방(성수) 후보창 확장으로 trainNo 6408이 유일하게
    // 잡혀 resolved된다. 아래 양방향 assert가 그 증거(8425는 여전히 배제, 2 hop+는 배제)를
    // 이어서 확인한다.
    expect(outcome).toBe('resolved');
    expect(lock?.trainCode).toBe('6408');

    // ---- 교정된 양방향 assert: production과 동일한 direction으로 재확인 ----
    // production이 실제로 쓰는 값(`boardingAnchorResolver.ts:534-538`)과 동일하게 계산한다 —
    // null로 느슨하게 두지 않는다.
    const direction = inferLegDirection('2', '뚝섬', '성수');
    expect(direction).toBe('up');

    const positions = await seoul.fetchPositions('2');
    const atDukseomFreshRightDirection = positions.filter(
      (p: PositionEntry) =>
        p.stationName === '뚝섬' &&
        p.isUp === (direction === 'up') &&
        p.recptnMs > 0 &&
        entry.tMs - p.recptnMs <= 120_000,
    );
    // 8425는 isUp=false(외선) — 방향 필터를 production과 동일하게 적용하면 애초에 후보 풀에도
    // 들어오지 못한다. DEPARTED(2)를 priority list에 추가해도(가정) 방향이 틀리면 여전히
    // 후보 0 — "DEPARTED 수용만으로는 해결되지 않는다"의 직접 증거.
    expect(atDukseomFreshRightDirection).toHaveLength(0);
    const stillNoneWithCorrectDirection = resolveTrainCodeFromPositions(
      { line: '2', boardingStation: '뚝섬', direction },
      positions,
      entry.tMs,
    );
    expect(stillNoneWithCorrectDirection.status).toBe('none');

    // ---- 진짜 해법 방향 증명: #2875 패턴(`arrivalsFromPositions.ts:52-61`, vanish swap 후보창
    // 확장)을 confirm anchor 경로에 동일하게 적용하면? ----
    // "앵커 역 정위치" 매칭 대신 "앵커 기준 진행방향 ±1 hop 창 + 방향 일치"로 후보를 잡는다
    // (프로덕션 코드는 수정하지 않는다 — 이 필터는 테스트 로컬 동치 로직).
    const ANCHOR_SEGMENT = ['뚝섬', '성수', '건대입구']; // 진행방향 순서(뚝섬→성수→건대입구)
    const anchorIdx = ANCHOR_SEGMENT.indexOf('뚝섬');
    const HOP_WINDOW = 1;
    const withinHopWindowAndDirection = positions.filter((p: PositionEntry) => {
      if (p.isUp !== (direction === 'up')) return false;
      const idx = ANCHOR_SEGMENT.indexOf(p.stationName);
      if (idx < 0 || Math.abs(idx - anchorIdx) > HOP_WINDOW) return false;
      return p.recptnMs > 0 && entry.tMs - p.recptnMs <= 120_000;
    });
    expect(withinHopWindowAndDirection).toHaveLength(1);
    expect(withinHopWindowAndDirection[0].trainCode).toBe('6408');
    expect(withinHopWindowAndDirection[0].stationName).toBe('성수');
    expect(withinHopWindowAndDirection[0].trainSttus).toBe(TRAIN_STATUS.DEPARTED);
  });
});
