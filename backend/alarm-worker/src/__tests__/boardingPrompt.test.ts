import { describe, expect, it } from 'vitest';
import { ARRIVAL_CODE } from '../alarm';
import {
  boardingPromptDedupKey,
  canBypassRepeatIntervalForTrainTransition,
  canFireForTrainCode,
  decideBoardingPromptFire,
  DISMISS_SILENCE_MS,
  evaluateBoardingPromptRepeatGate,
  evaluateHopEndPromptGates,
  hasFreshOriginProximityCorroboration,
  markPromptFired,
  markPromptSilenced,
  MAX_FIRES_PER_TRAIN_CODE,
  pickAutoTrainCode,
  trainCodeFireCount,
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

// #2880 — selectedTrainCode=null dedup fail-open fix. firedTrainCodes dedup이 trainCode를
// 특정할 수 없을 때도(null) 작동하도록 phase 기반 fallback 키를 반환한다.
// #2898 — selectedTrainCode가 non-null이어도 phase(decision)를 포함하도록 변경(아래 신규
// describe 참고) — approaching→arrival 재확인(스펙 ①)이 동일 trainCode라는 이유만으로
// dedup에 막히지 않으려면 phase까지 키에 포함해야 한다.
describe('boardingPromptDedupKey (#2880)', () => {
  it('selectedTrainCode가 non-null이면 "trainCode:decision" 형식(#2898 — phase도 키에 포함)', () => {
    expect(boardingPromptDedupKey('U1', 'approaching')).toBe('U1:approaching');
    expect(boardingPromptDedupKey('U1', 'imminent')).toBe('U1:imminent');
  });

  it('#2898 — 같은 trainCode라도 phase가 다르면 다른 키(재발사 허용의 입력)', () => {
    expect(boardingPromptDedupKey('U1', 'approaching')).not.toBe(
      boardingPromptDedupKey('U1', 'imminent'),
    );
  });

  it('selectedTrainCode=null이면 phase(decision)를 포함한 fallback 키 반환', () => {
    expect(boardingPromptDedupKey(null, 'approaching')).toBe('null-trainCode:approaching');
    expect(boardingPromptDedupKey(null, 'imminent')).toBe('null-trainCode:imminent');
    expect(boardingPromptDedupKey(null, 'fallback-unobservable')).toBe(
      'null-trainCode:fallback-unobservable',
    );
  });

  it('null이어도 phase가 다르면 다른 키 — 과차단 방지(phase 전환은 재발사 허용)', () => {
    expect(boardingPromptDedupKey(null, 'approaching')).not.toBe(
      boardingPromptDedupKey(null, 'imminent'),
    );
  });
});

// #2898 — 같은 trainCode에 대해 phase 무관 최대 2회(approaching+arrival)까지만 허용하는 하드 캡.
describe('trainCodeFireCount / canFireForTrainCode (#2898)', () => {
  it('firedTrainCodes가 비어있으면 count=0, canFire=true', () => {
    expect(trainCodeFireCount(undefined, 'U1')).toBe(0);
    expect(canFireForTrainCode(undefined, 'U1')).toBe(true);
  });

  it('같은 trainCode의 phase별 키가 섞여 있어도 trainCode 기준으로 센다', () => {
    const firedTrainCodes = ['U1:approaching', 'U2:imminent'];
    expect(trainCodeFireCount(firedTrainCodes, 'U1')).toBe(1);
    expect(trainCodeFireCount(firedTrainCodes, 'U2')).toBe(1);
    expect(trainCodeFireCount(firedTrainCodes, 'U3')).toBe(0);
  });

  it(`MAX_FIRES_PER_TRAIN_CODE(${MAX_FIRES_PER_TRAIN_CODE}) 도달 시 canFireForTrainCode=false`, () => {
    const firedTrainCodes = ['U1:approaching', 'U1:imminent'];
    expect(trainCodeFireCount(firedTrainCodes, 'U1')).toBe(MAX_FIRES_PER_TRAIN_CODE);
    expect(canFireForTrainCode(firedTrainCodes, 'U1')).toBe(false);
  });

  it('selectedTrainCode=null이면 null-trainCode 토큰으로 센다(#2880 fallback과 정합)', () => {
    const firedTrainCodes = ['null-trainCode:approaching'];
    expect(trainCodeFireCount(firedTrainCodes, null)).toBe(1);
    expect(canFireForTrainCode(firedTrainCodes, null)).toBe(true);
  });

  // #2898 배포 경계 — 이 fix 이전에는 dedup 키가 phase 없이 trainCode 그대로였다(':' 없음).
  // 배포 시점에 in-flight인 trip의 firedTrainCodes가 구형식으로 남아있을 수 있으므로, ':' 없는
  // 키도 트레인코드 전체를 토큰으로 안전하게 인식해야 한다(하위 호환).
  it('구형식 키(":" 없는 bare trainCode)도 토큰 전체로 안전하게 인식한다(배포 경계 하위 호환)', () => {
    const firedTrainCodes = ['U1'];
    expect(trainCodeFireCount(firedTrainCodes, 'U1')).toBe(1);
    expect(canFireForTrainCode(firedTrainCodes, 'U1')).toBe(true);
  });
});

// #2898 — 'fired-too-recently'(5분 간격) 소프트 블록의 same-train bypass 최종 판정.
describe('canBypassRepeatIntervalForTrainTransition (#2898)', () => {
  it('firedTrainCodes가 비어있으면(발사 이력 없음) bypass 불가(false) — 호출 전제 위반 방어', () => {
    expect(canBypassRepeatIntervalForTrainTransition(undefined, 'U1')).toBe(false);
    expect(canBypassRepeatIntervalForTrainTransition([], 'U1')).toBe(false);
  });

  it('스펙 ① — 같은 trainCode(U1) 재확인, 직전 발사 1회뿐(소진 전) → bypass 허용', () => {
    expect(canBypassRepeatIntervalForTrainTransition(['U1:approaching'], 'U1')).toBe(true);
  });

  it('스펙 ③(거부 ⓑ) — 같은 trainCode(U1)가 이미 2회(소진) → bypass 거부', () => {
    expect(
      canBypassRepeatIntervalForTrainTransition(['U1:approaching', 'U1:imminent'], 'U1'),
    ).toBe(false);
  });

  it('스펙 ④ — 직전 trainCode(U1)가 2회 소진된 뒤 다른 trainCode(U3) → bypass 허용(새 cycle)', () => {
    expect(
      canBypassRepeatIntervalForTrainTransition(['U1:approaching', 'U1:imminent'], 'U3'),
    ).toBe(true);
  });

  it('거부 케이스 ⓒ — 직전 trainCode(U1)가 1회뿐(소진 전)인데 다른 trainCode(U5) → bypass 거부(단배차 스팸 방지)', () => {
    expect(canBypassRepeatIntervalForTrainTransition(['U1:approaching'], 'U5')).toBe(false);
  });

  it('거부 케이스 ⓓ — selectedTrainCode=null이어도 동일 로직(null-trainCode 토큰)으로 판정', () => {
    expect(
      canBypassRepeatIntervalForTrainTransition(['null-trainCode:approaching'], null),
    ).toBe(true);
    expect(
      canBypassRepeatIntervalForTrainTransition(['U1:approaching'], null),
    ).toBe(false);
  });

  // #2898 배포 경계 — 구형식 키(':' 없음)가 마지막 발사로 남아있어도 토큰 비교가 안전하게
  // 동작한다(trainCodeFireCount와 동일 하위 호환).
  it('구형식 마지막 키(":" 없음)도 토큰 전체로 비교한다(배포 경계 하위 호환)', () => {
    expect(canBypassRepeatIntervalForTrainTransition(['U1'], 'U1')).toBe(true);
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

  // #2801 (3차 reopen, audit-sides 편측 확정) — 3(전역출발)이 별도 tier로 승격돼 더 이상
  // "그 외" 코드가 아니다. 4(전역진입, 의도적 제외)로 교체해 "어느 tier에도 안 걸리는 코드만
  // 있으면 받은 순서 첫 후보" 계약을 유지한다.
  it('priority 6: 그 외 코드(0/1/2/3/5 아님) → 첫 후보 (receivedAt 순서 가정)', () => {
    const arrivals = [
      entry({ trainCode: 'T1', arvlCd: 99 }),
      entry({ trainCode: 'T2', arvlCd: 4 }),
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

  /**
   * #2801 (audit-sides 편측 확정, 2026-10-03) — approaching(3/5) 발사 프롬프트에 사용자가
   * [탑승] 응답하면 3/5 후보가 priority 배열([2,1,0])의 어느 tier에도 안 걸려
   * `directional[0]`(Seoul API 수신 순서 첫 후보)로 ambiguity 보호 없이 silent 선택된다 —
   * 엉뚱한 열차 lock 가능. priority에 3/5를 각자 별도 tier로 추가해 기존 ambiguity 룰을
   * 그대로 적용한다. 순서: 2>1>0(기존, 회고형 — 진행도 높을수록 탑승 열차일 확률 높음) >
   * 3(전역출발, 도착 근접) > 5(전역도착).
   */
  it('priority 5: arvlCd=5 (전역도착) — 2/1/0 없고 99(운행중)와 공존해도 5가 채택 (99-only directional[0] fallback과 구분)', () => {
    const arrivals = [
      entry({ trainCode: 'B', arvlCd: 99 }),
      entry({ trainCode: 'A', arvlCd: 5 }),
    ];
    expect(pickAutoTrainCode(arrivals, '2호선', 'up')).toBe('A');
  });

  it('ambiguity: 같은 approaching tier(arvlCd=5) 후보 2+ → null', () => {
    const arrivals = [
      entry({ trainCode: 'T1', arvlCd: 5 }),
      entry({ trainCode: 'T2', arvlCd: 5 }),
    ];
    expect(pickAutoTrainCode(arrivals, '2호선', 'up')).toBeNull();
  });

  it('priority 4: arvlCd=3 (전역출발) — 3이 5(전역도착)보다 우선(도착 더 근접)', () => {
    const arrivals = [
      entry({ trainCode: 'T5', arvlCd: 5 }),
      entry({ trainCode: 'T3', arvlCd: 3 }),
    ];
    expect(pickAutoTrainCode(arrivals, '2호선', 'up')).toBe('T3');
  });

  it('99-only pool은 여전히 directional[0] fallback(변경 금지, 기존 동작)', () => {
    const arrivals = [
      entry({ trainCode: 'T1', arvlCd: 99 }),
      entry({ trainCode: 'T2', arvlCd: 99 }),
    ];
    expect(pickAutoTrainCode(arrivals, '2호선', 'up')).toBe('T1');
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

  it('지상 먼 열차만(arvlCd=[4,99], 전부 관측됨) → fire:false, decision=suppressed-not-imminent (9/30 조기 발사 회귀 재현 — 4는 APPROACHING에서 의도적 제외)', () => {
    const result = decideBoardingPromptFire([{ arvlCd: 4 }, { arvlCd: 99 }]);
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

/**
 * #2801 (3차 reopen, 2026-10-03) — approaching 게이트.
 *
 * 10/2 실측 트립 D1 RCA: leg-2 boarding-prompt 시도 9회 전부 `suppressed-not-imminent` —
 * arvlCd∈{0,1,2}(imminent)가 cron 60s 샘플에 한 번도 안 걸리고, 가장 근접한 관측은
 * 5(전역도착)/3(전역출발)였다. 이 둘을 발사 집합에 추가(decision='approaching'으로 분리),
 * 4(전역진입)는 9/30 조기 발사 창(≈2~3분 전)에 근접해 의도적으로 제외한다.
 *
 * RED(fix 전): 아래 [5]/[3] 케이스는 현행 코드에서 decision='suppressed-not-imminent'로
 * 나와 실패한다(IMMINENT_BOARDING_ARVLCD에 3/5가 없음).
 */
describe('#2801 (3차 reopen) — decideBoardingPromptFire approaching(전역출발/전역도착) 게이트', () => {
  it('전역도착(arvlCd=5)만 → fire:true, decision=approaching', () => {
    const result = decideBoardingPromptFire([{ arvlCd: 5 }]);
    expect(result).toEqual({ fire: true, decision: 'approaching' });
  });

  it('전역출발(arvlCd=3)만 → fire:true, decision=approaching', () => {
    const result = decideBoardingPromptFire([{ arvlCd: 3 }]);
    expect(result).toEqual({ fire: true, decision: 'approaching' });
  });

  it('전역진입(arvlCd=4)만 → fire:false, decision=suppressed-not-imminent (의도적 제외, 거부 케이스)', () => {
    const result = decideBoardingPromptFire([{ arvlCd: 4 }]);
    expect(result).toEqual({ fire: false, decision: 'suppressed-not-imminent' });
  });

  it('운행중만(arvlCd=99) → fire:false, decision=suppressed-not-imminent', () => {
    const result = decideBoardingPromptFire([{ arvlCd: 99 }]);
    expect(result).toEqual({ fire: false, decision: 'suppressed-not-imminent' });
  });

  it('임박(arvlCd=2 DEPARTED)이 있으면 approaching 후보가 섞여도 imminent가 우선 (기존 유지)', () => {
    const result = decideBoardingPromptFire([{ arvlCd: 2 }, { arvlCd: 5 }]);
    expect(result).toEqual({ fire: true, decision: 'imminent' });
  });

  it('혼합(arvlCd=[5, null]) → approaching이 결정적 신호이므로 null-fallback보다 우선', () => {
    const result = decideBoardingPromptFire([{ arvlCd: 5 }, { arvlCd: null }]);
    expect(result).toEqual({ fire: true, decision: 'approaching' });
  });
});
