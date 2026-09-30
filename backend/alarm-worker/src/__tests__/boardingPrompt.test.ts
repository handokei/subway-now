import { describe, expect, it } from 'vitest';
import { ARRIVAL_CODE } from '../alarm';
import {
  decideBoardingPromptFire,
  DISMISS_SILENCE_MS,
  evaluateBoardingPromptRepeatGate,
  evaluateHopEndPromptGates,
  hasFreshOriginProximityCorroboration,
  markPromptFired,
  markPromptSilenced,
  pickAutoTrainCode,
} from '../boardingPrompt';
import type { ArrivalEntry } from '../seoul';

// #2844 — 은퇴한 `evaluateBoardingPromptGates`(GPS 9단)가 이 게이트의 모든 분기(silenced/
// max-fires-reached/fired-too-recently/pass)를 간접적으로 exercise했다 — 그 함수 삭제로
// 커버리지 공백이 생겨 직접 단위 테스트로 복원한다(이식 대상 없음, 순수 게이트 로직 자체 검증).
describe('evaluateBoardingPromptRepeatGate (#2531)', () => {
  const NOW = 1_700_000_000_000;

  it('promptState 부재 → null(통과)', () => {
    expect(evaluateBoardingPromptRepeatGate(undefined, NOW)).toBeNull();
  });

  it('silencedUntil이 now보다 미래 → silenced 차단', () => {
    const outcome = evaluateBoardingPromptRepeatGate(
      { fired: false, silencedUntil: NOW + 1000 },
      NOW,
    );
    expect(outcome).not.toBeNull();
    expect(outcome?.pass).toBe(false);
    if (outcome && !outcome.pass) expect(outcome.reason).toBe('silenced');
  });

  it('silencedUntil이 now 이하(만료) → silenced 아님, 다음 게이트로 진행(통과)', () => {
    const outcome = evaluateBoardingPromptRepeatGate(
      { fired: false, silencedUntil: NOW - 1 },
      NOW,
    );
    expect(outcome).toBeNull();
  });

  it('fireCount이 MAX_FIRE_COUNT(3) 이상 → max-fires-reached 차단', () => {
    const outcome = evaluateBoardingPromptRepeatGate({ fired: true, fireCount: 3 }, NOW);
    expect(outcome).not.toBeNull();
    expect(outcome?.pass).toBe(false);
    if (outcome && !outcome.pass) expect(outcome.reason).toBe('max-fires-reached');
  });

  it('lastFiredAt이 MIN_FIRE_INTERVAL_MS(5분) 미만 경과 → fired-too-recently 차단', () => {
    const outcome = evaluateBoardingPromptRepeatGate(
      { fired: true, fireCount: 1, lastFiredAt: NOW - 60_000 },
      NOW,
    );
    expect(outcome).not.toBeNull();
    expect(outcome?.pass).toBe(false);
    if (outcome && !outcome.pass) expect(outcome.reason).toBe('fired-too-recently');
  });

  it('모든 게이트 통과(신선한 상태) → null(통과)', () => {
    const outcome = evaluateBoardingPromptRepeatGate(
      { fired: true, fireCount: 1, lastFiredAt: NOW - 10 * 60_000 },
      NOW,
    );
    expect(outcome).toBeNull();
  });
});

describe('markPromptFired / markPromptSilenced', () => {
  it('markPromptFired는 fired=true + lastFiredAt 설정 (prev/trainCode 없으면 fireCount=1, firedTrainCodes 생략)', () => {
    expect(markPromptFired(1234)).toEqual({ fired: true, lastFiredAt: 1234, fireCount: 1 });
  });

  // #2130 (Part B-be-2) — 반복 발사(A4) 상태 누적.
  it('markPromptFired: prev + trainCode 전달 시 firedTrainCodes append + fireCount 증가', () => {
    const prev = { fired: true, lastFiredAt: 1000, fireCount: 1, firedTrainCodes: ['A1'] };
    const r = markPromptFired(2000, prev, 'B2');
    expect(r).toEqual({
      fired: true,
      lastFiredAt: 2000,
      fireCount: 2,
      firedTrainCodes: ['A1', 'B2'],
    });
  });

  it('markPromptFired: trainCode=null 이면 firedTrainCodes는 prev 그대로(append 없음)', () => {
    const prev = { fired: true, lastFiredAt: 1000, fireCount: 1, firedTrainCodes: ['A1'] };
    const r = markPromptFired(2000, prev, null);
    expect(r.firedTrainCodes).toEqual(['A1']);
    expect(r.fireCount).toBe(2);
  });
  it('markPromptSilenced는 silencedUntil = now + DISMISS_SILENCE_MS', () => {
    const r = markPromptSilenced(undefined, 1000);
    expect(r.silencedUntil).toBe(1000 + DISMISS_SILENCE_MS);
  });
  it('markPromptSilenced는 기존 fired 상태 보존', () => {
    const r = markPromptSilenced({ fired: true, lastFiredAt: 500 }, 1000);
    expect(r.fired).toBe(true);
    expect(r.lastFiredAt).toBe(500);
  });
});

describe('hasFreshOriginProximityCorroboration (#2653, 코드리뷰 MEDIUM-2)', () => {
  const NOW = 1_700_000_000_000;
  const FRESH_MS = 5 * 60_000;
  const CUTOFF_M = 50;

  it('최신 sample 부재 → false', () => {
    expect(hasFreshOriginProximityCorroboration(undefined, NOW, FRESH_MS, CUTOFF_M)).toBe(false);
  });

  it('최신 sample이 신선하고(≤freshnessMs) 정확도 양호(<cutoff) → true', () => {
    const point = { ts: NOW - 60_000, accuracy: 10 };
    expect(hasFreshOriginProximityCorroboration(point, NOW, FRESH_MS, CUTOFF_M)).toBe(true);
  });

  it('최신 sample이 freshnessMs를 초과해 stale → false', () => {
    const point = { ts: NOW - (FRESH_MS + 1), accuracy: 10 };
    expect(hasFreshOriginProximityCorroboration(point, NOW, FRESH_MS, CUTOFF_M)).toBe(false);
  });

  it('최신 sample은 신선하지만 accuracy가 cutoff 이상(저정확도) → false', () => {
    const point = { ts: NOW, accuracy: CUTOFF_M };
    expect(hasFreshOriginProximityCorroboration(point, NOW, FRESH_MS, CUTOFF_M)).toBe(false);
  });
});

describe('pickAutoTrainCode — arvlCd 우선순위', () => {
  function entry(overrides: Partial<ArrivalEntry>): ArrivalEntry {
    return {
      destination: '',
      arrivalSeconds: 0,
      trainCode: 'T1',
      isUp: true,
      subwayNm: '2호선',
      arvlCd: null,
      ...overrides,
    };
  }

  it('priority 1: arvlCd=2 (출발) 단독 → 채택', () => {
    const arrivals = [
      entry({ trainCode: 'T1', arvlCd: 0 }),
      entry({ trainCode: 'T2', arvlCd: 2 }),
      entry({ trainCode: 'T3', arvlCd: ARRIVAL_CODE.ARRIVED }),
    ];
    expect(pickAutoTrainCode(arrivals, '2호선', 'up')).toBe('T2');
  });

  it('priority 2: arvlCd=1 (도착) — arvlCd=2 없을 때', () => {
    const arrivals = [
      entry({ trainCode: 'T1', arvlCd: 0 }),
      entry({ trainCode: 'T2', arvlCd: ARRIVAL_CODE.ARRIVED }),
    ];
    expect(pickAutoTrainCode(arrivals, '2호선', 'up')).toBe('T2');
  });

  it('priority 3: arvlCd=0 (진입) — 2/1 없을 때', () => {
    const arrivals = [entry({ trainCode: 'T1', arvlCd: 0 })];
    expect(pickAutoTrainCode(arrivals, '2호선', 'up')).toBe('T1');
  });

  it('priority 4: 그 외 코드 → 첫 후보 (receivedAt 순서 가정)', () => {
    const arrivals = [
      entry({ trainCode: 'T1', arvlCd: 99 }),
      entry({ trainCode: 'T2', arvlCd: 3 }),
    ];
    expect(pickAutoTrainCode(arrivals, '2호선', 'up')).toBe('T1');
  });

  it('ambiguity: 같은 우선순위 후보 2+ → null (자동 lock 안 함)', () => {
    const arrivals = [
      entry({ trainCode: 'T1', arvlCd: 2 }),
      entry({ trainCode: 'T2', arvlCd: 2 }),
    ];
    expect(pickAutoTrainCode(arrivals, '2호선', 'up')).toBeNull();
  });

  it('line 매칭 안 되면 null', () => {
    const arrivals = [entry({ trainCode: 'T1', arvlCd: 2, subwayNm: '99호선' })];
    expect(pickAutoTrainCode(arrivals, '2호선', 'up')).toBeNull();
  });

  it('direction null → 양방향 허용', () => {
    const arrivals = [entry({ trainCode: 'T1', arvlCd: 2, isUp: false })];
    expect(pickAutoTrainCode(arrivals, '2호선', null)).toBe('T1');
  });

  it('direction=down → 하행만 매칭', () => {
    const arrivals = [
      entry({ trainCode: 'TU', arvlCd: 2, isUp: true }),
      entry({ trainCode: 'TD', arvlCd: 2, isUp: false }),
    ];
    expect(pickAutoTrainCode(arrivals, '2호선', 'down')).toBe('TD');
  });

  it('방향 매칭 후 모두 제거되면 null', () => {
    const arrivals = [entry({ trainCode: 'T1', arvlCd: 2, isUp: true })];
    expect(pickAutoTrainCode(arrivals, '2호선', 'down')).toBeNull();
  });

  it('trainCode 빈 문자열 후보 → null', () => {
    const arrivals = [entry({ trainCode: '', arvlCd: 2 })];
    expect(pickAutoTrainCode(arrivals, '2호선', 'up')).toBeNull();
  });
});

describe('evaluateHopEndPromptGates (#2034)', () => {
  const NOW = 1_700_000_000_000;

  it('promptState 없음 → pass=true', () => {
    const r = evaluateHopEndPromptGates({ now: NOW });
    expect(r.pass).toBe(true);
    if (r.pass) expect(r.fusedSpeedKmh).toBe(0);
  });

  it('promptState.fired=true → already-fired 차단', () => {
    const r = evaluateHopEndPromptGates({
      promptState: { fired: true, lastFiredAt: NOW - 60_000 },
      now: NOW,
    });
    expect(r.pass).toBe(false);
    if (!r.pass) expect(r.reason).toBe('already-fired');
  });

  it('promptState.silencedUntil 이 미래 → silenced 차단', () => {
    const r = evaluateHopEndPromptGates({
      promptState: { silencedUntil: NOW + 30_000 },
      now: NOW,
    });
    expect(r.pass).toBe(false);
    if (!r.pass) expect(r.reason).toBe('silenced');
  });

  it('promptState.silencedUntil 이 과거 → pass', () => {
    const r = evaluateHopEndPromptGates({
      promptState: { silencedUntil: NOW - 30_000 },
      now: NOW,
    });
    expect(r.pass).toBe(true);
  });
});

/**
 * #2801 (REOPENED 2026-09-30 정정 스펙 §2/§5) — 조기 발사 봉합 OR-fallback 게이트.
 *
 * 9/30 실측 트립(e25e1158) D1 RCA: leg-2 boarding-prompt가 열차(3056)가 아직 도착 전인데
 * (candidateTrains에 먼 열차만 있는데도) 발사됐다(06:42/06:44, 열차는 06:46 도착).
 * `fireBoardingPromptForAnchor`의 유일 게이트가 `candidateTrains.length===0`뿐이라 "아무 열차나
 * pool에 있으면" 발사되는 구조 — arvlCd(임박 여부) 검사가 아예 없었다.
 *
 * RED(fix 전): `decideBoardingPromptFire`가 아직 export되지 않아 이 파일 자체가 컴파일 실패.
 * GREEN(fix 후): 아래 케이스가 전부 통과.
 */
describe('#2801 — decideBoardingPromptFire (조기 발사 OR-fallback 게이트)', () => {
  it('지상 임박(arvlCd=1 ARRIVED 존재) → fire:true, decision=imminent', () => {
    const result = decideBoardingPromptFire([{ arvlCd: ARRIVAL_CODE.ARRIVED }, { arvlCd: 99 }]);
    expect(result).toEqual({ fire: true, decision: 'imminent' });
  });

  it('지상 먼 열차만(arvlCd=[3,99], 전부 관측됨) → fire:false, decision=suppressed-not-imminent (9/30 조기 발사 회귀 재현)', () => {
    const result = decideBoardingPromptFire([{ arvlCd: 3 }, { arvlCd: 99 }]);
    expect(result).toEqual({ fire: false, decision: 'suppressed-not-imminent' });
  });

  it('지하 전부 null → fire:true, decision=fallback-unobservable (miss 재발 방지)', () => {
    const result = decideBoardingPromptFire([{ arvlCd: null }, { arvlCd: null }]);
    expect(result).toEqual({ fire: true, decision: 'fallback-unobservable' });
  });

  it('혼합(arvlCd=[99, null]) → fire:true, decision=fallback-unobservable (관측 불가 우선, miss 방지)', () => {
    const result = decideBoardingPromptFire([{ arvlCd: 99 }, { arvlCd: null }]);
    expect(result).toEqual({ fire: true, decision: 'fallback-unobservable' });
  });

  it('출발만(arvlCd=[2] DEPARTED) → fire:true, decision=imminent (회고형 정합 — 폴링 갭에 진입→도착→출발이 한 tick에 지나갈 수 있음)', () => {
    const result = decideBoardingPromptFire([{ arvlCd: ARRIVAL_CODE.DEPARTED }]);
    expect(result).toEqual({ fire: true, decision: 'imminent' });
  });

  it('진입(arvlCd=0 ENTERING) → fire:true, decision=imminent', () => {
    const result = decideBoardingPromptFire([{ arvlCd: ARRIVAL_CODE.ENTERING }]);
    expect(result).toEqual({ fire: true, decision: 'imminent' });
  });

  it('pool 빈 배열 → fire:false, decision=suppressed-not-imminent (imminent 0건 & null 0건 = "전부 관측되고 임박 없음"에 해당)', () => {
    const result = decideBoardingPromptFire([]);
    expect(result).toEqual({ fire: false, decision: 'suppressed-not-imminent' });
  });
});
