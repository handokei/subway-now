import { describe, expect, it } from 'vitest';
import { ARRIVAL_CODE } from '../alarm';
import {
  boardingPromptDedupKey,
  boardingPromptFireOnceKey,
  canBypassRepeatIntervalForTrainTransition,
  canFireForTrainCode,
  decideBoardingPromptFire,
  DISMISS_SILENCE_MS,
  evaluateBoardingPromptRepeatGate,
  evaluateHopEndPromptGates,
  hasFreshOriginProximityCorroboration,
  isExactDuplicateFire,
  markPromptFired,
  markPromptSilenced,
  MAX_FIRES_PER_TRAIN_CODE,
  mergePositionConfirmedIntoPool,
  pickAutoTrainCode,
  PROMPT_POSITION_FRESH_MS,
  selectPositionConfirmedTrains,
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
    expect(boardingPromptDedupKey('U1', 'position-confirmed')).toBe('U1:position-confirmed');
    expect(boardingPromptDedupKey('U1', 'imminent')).toBe('U1:imminent');
  });

  it('#2898 — 같은 trainCode라도 phase가 다르면 다른 키(재발사 허용의 입력)', () => {
    expect(boardingPromptDedupKey('U1', 'position-confirmed')).not.toBe(
      boardingPromptDedupKey('U1', 'imminent'),
    );
  });

  it('selectedTrainCode=null이면 phase(decision)를 포함한 fallback 키 반환', () => {
    expect(boardingPromptDedupKey(null, 'position-confirmed')).toBe('null-trainCode:position-confirmed');
    expect(boardingPromptDedupKey(null, 'imminent')).toBe('null-trainCode:imminent');
    expect(boardingPromptDedupKey(null, 'fallback-unobservable')).toBe(
      'null-trainCode:fallback-unobservable',
    );
  });

  it('null이어도 phase가 다르면 다른 키 — 과차단 방지(phase 전환은 재발사 허용)', () => {
    expect(boardingPromptDedupKey(null, 'position-confirmed')).not.toBe(
      boardingPromptDedupKey(null, 'imminent'),
    );
  });
});

// #2898 -> #3057 — 같은 trainCode에 대해 phase 무관 최대 1회(도착 확정 1회)만 허용하는 하드 캡.
// (구 2회 = approaching 1 + arrival 1. approaching 발사가 제거돼 1로 수렴.)
describe('trainCodeFireCount / canFireForTrainCode (#2898, #3057 상한 1)', () => {
  it('상한은 1(#3057 — approaching 발사 제거로 arrival 1회로 수렴)', () => {
    expect(MAX_FIRES_PER_TRAIN_CODE).toBe(1);
  });

  it('firedTrainCodes가 비어있으면 count=0, canFire=true', () => {
    expect(trainCodeFireCount(undefined, 'U1')).toBe(0);
    expect(canFireForTrainCode(undefined, 'U1')).toBe(true);
  });

  it('같은 trainCode의 phase별 키가 섞여 있어도 trainCode 기준으로 센다', () => {
    const firedTrainCodes = ['U1:position-confirmed', 'U2:imminent'];
    expect(trainCodeFireCount(firedTrainCodes, 'U1')).toBe(1);
    expect(trainCodeFireCount(firedTrainCodes, 'U2')).toBe(1);
    expect(trainCodeFireCount(firedTrainCodes, 'U3')).toBe(0);
  });

  it('상한 도달 시 canFireForTrainCode=false — 같은 열차가 position->arrival로 두 번 확정돼도 1회', () => {
    const firedTrainCodes = ['U1:position-confirmed'];
    expect(trainCodeFireCount(firedTrainCodes, 'U1')).toBe(MAX_FIRES_PER_TRAIN_CODE);
    expect(canFireForTrainCode(firedTrainCodes, 'U1')).toBe(false);
    expect(canFireForTrainCode(firedTrainCodes, 'U2')).toBe(true);
  });

  it('selectedTrainCode=null이면 null-trainCode 토큰으로 센다(#2880 fallback과 정합)', () => {
    const firedTrainCodes = ['null-trainCode:position-confirmed'];
    expect(trainCodeFireCount(firedTrainCodes, null)).toBe(1);
    // null-token 상한은 2(ambiguous 후 영구 침묵 방지) — 1회 후엔 아직 발사 가능, 2회 후 차단.
    expect(canFireForTrainCode(firedTrainCodes, null)).toBe(true);
    expect(canFireForTrainCode([...firedTrainCodes, 'null-trainCode:imminent'], null)).toBe(false);
  });

  // #2898 배포 경계 — 구형식(':' 없는 bare trainCode) 키도 토큰 전체로 안전하게 인식(하위 호환).
  it('구형식 키(":" 없는 bare trainCode)도 토큰 전체로 안전하게 인식한다(배포 경계 하위 호환)', () => {
    const firedTrainCodes = ['U1'];
    expect(trainCodeFireCount(firedTrainCodes, 'U1')).toBe(1);
    expect(canFireForTrainCode(firedTrainCodes, 'U1')).toBe(false);
  });
});

// #2898 -> #3057 — 'fired-too-recently'(5분 간격) 소프트 블록의 새 열차 bypass 최종 판정.
describe('canBypassRepeatIntervalForTrainTransition (#2898, #3057 상한 1)', () => {
  it('firedTrainCodes가 비어있으면(발사 이력 없음) bypass 불가(false) — 호출 전제 위반 방어', () => {
    expect(canBypassRepeatIntervalForTrainTransition(undefined, 'U1')).toBe(false);
    expect(canBypassRepeatIntervalForTrainTransition([], 'U1')).toBe(false);
  });

  it('거부 — 같은 trainCode(U1)는 이미 1회(소진) -> bypass 거부(같은 열차 재발사 금지)', () => {
    expect(canBypassRepeatIntervalForTrainTransition(['U1:position-confirmed'], 'U1')).toBe(false);
    expect(
      canBypassRepeatIntervalForTrainTransition(['U1:position-confirmed', 'U1:imminent'], 'U1'),
    ).toBe(false);
  });

  it('스펙 ④ — 직전 trainCode(U1)가 소진된 뒤 다른 trainCode(U3) -> bypass 허용(9/18 건대입구 7254->7256 단배차)', () => {
    expect(canBypassRepeatIntervalForTrainTransition(['U1:position-confirmed'], 'U3')).toBe(true);
  });

  it('selectedTrainCode=null은 null-trainCode 토큰으로 판정(같은 토큰 거부 / 실 열차로 바뀌면 허용)', () => {
    expect(canBypassRepeatIntervalForTrainTransition(['null-trainCode:position-confirmed'], null)).toBe(true);
    expect(
      canBypassRepeatIntervalForTrainTransition(['null-trainCode:position-confirmed', 'null-trainCode:imminent'], null),
    ).toBe(false);
    expect(canBypassRepeatIntervalForTrainTransition(['U1:position-confirmed'], null)).toBe(true);
    // null이 마지막이고 상한(2) 미달이면 새 열차도 아직 bypass 불가, 소진(2회)되면 허용.
    expect(canBypassRepeatIntervalForTrainTransition(['null-trainCode:position-confirmed'], 'U1')).toBe(false);
    expect(
      canBypassRepeatIntervalForTrainTransition(['null-trainCode:position-confirmed', 'null-trainCode:imminent'], 'U1'),
    ).toBe(true);
  });

  // #2898 배포 경계 — 구형식 마지막 키(':' 없음)도 토큰 전체로 비교한다.
  it('구형식 마지막 키(":" 없음)도 토큰 전체로 비교한다(배포 경계 하위 호환)', () => {
    expect(canBypassRepeatIntervalForTrainTransition(['U1'], 'U1')).toBe(false);
    expect(canBypassRepeatIntervalForTrainTransition(['U1'], 'U2')).toBe(true);
  });
});

// #2898 배포 경계 하위호환 — fix 배포 순간 in-flight였던 trip은 firedTrainCodes에 구형식
// (':' 없는 bare trainCode, phase 정보 없음) 항목을 가질 수 있다. exact-duplicate 판정이
// 새 dedupKey(`trainCode:decision`)로만 정확매치하면 그 항목을 못 알아봐 똑같은 phase를
// 다시 관측해도(=진행 없음, 진짜 중복) 재발사를 허용할 위험이 있다 — 구형식을 만나면
// trainCode만으로 보수적으로 "중복"으로 간주해 그 위험을 없앤다.
describe('isExactDuplicateFire (#2898, 배포 경계 하위호환)', () => {
  it('firedTrainCodes가 비어있으면 중복 아님', () => {
    expect(isExactDuplicateFire(undefined, 'U1', 'imminent')).toBe(false);
    expect(isExactDuplicateFire([], 'U1', 'imminent')).toBe(false);
  });

  it('신형식 — 같은 trainCode라도 phase가 다르면 중복 아님(재확인 허용, 스펙 ①)', () => {
    expect(isExactDuplicateFire(['U1:position-confirmed'], 'U1', 'imminent')).toBe(false);
  });

  it('신형식 — trainCode+phase가 완전히 같으면 중복', () => {
    expect(isExactDuplicateFire(['U1:imminent'], 'U1', 'imminent')).toBe(true);
  });

  it('구형식(":" 없음) — phase 무관 trainCode 일치만으로 보수적으로 중복 처리(배포 경계)', () => {
    // 구코드는 trainCode만 보고 차단했다 — 구형식 항목을 만나면 phase가 뭐였는지 알 수 없으니
    // 지금 phase와 무관하게 "이미 이 trainCode로 쐈다"로 보고 차단한다(과차단이 안전).
    expect(isExactDuplicateFire(['U1'], 'U1', 'imminent')).toBe(true);
    expect(isExactDuplicateFire(['U1'], 'U1', 'position-confirmed')).toBe(true);
  });

  it('구형식(":" 없음) — trainCode 자체가 다르면 중복 아님', () => {
    expect(isExactDuplicateFire(['U1'], 'U2', 'imminent')).toBe(false);
  });

  it('selectedTrainCode=null — null-trainCode 토큰 기준으로 신/구형식 동일 로직 적용', () => {
    expect(isExactDuplicateFire(['null-trainCode:imminent'], null, 'imminent')).toBe(true);
    expect(isExactDuplicateFire(['null-trainCode:position-confirmed'], null, 'imminent')).toBe(false);
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

  // #2944 (H-6) — direction=null fail-closed. 구 동작("양방향 허용")은 10/9 반대 방향 lock
  // 사고(군자→광화문, 5호선)의 근본 원인이었다 — device #2696 정책(양방향 병합 금지)을
  // backend에도 적용한다. 방향을 모르면 lock 대상 후보를 내지 않는다(0건, null).
  it('direction null → 후보 없음 (fail-closed, #2944 — 구 "양방향 허용" 회귀 차단)', () => {
    const arrivals = [entry({ trainCode: 'T1', arvlCd: 2, isUp: false })];
    expect(pickAutoTrainCode(arrivals, '2호선', null)).toBeNull();
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
 * #3057 (2026-10-19 사용자 결정) — 도착 확정 게이트. #2801 임박집합{0,1,2}과 3차 reopen
 * approaching{3,5} 타이밍 결정을 대체한다: arvlCd {1,2} 또는 position 확정일 때만 발사,
 * 진입(0)/전역출발(3)/전역진입(4)/전역도착(5)/운행중(99)은 확정이 아니다.
 */
describe('#3057 — decideBoardingPromptFire (도착 확정 게이트)', () => {
  it('도착(arvlCd=1) 존재 → fire:true, decision=imminent', () => {
    expect(decideBoardingPromptFire([{ arvlCd: ARRIVAL_CODE.ARRIVED }, { arvlCd: 99 }])).toEqual({
      fire: true,
      decision: 'imminent',
    });
  });

  it('출발(arvlCd=2) → fire:true, decision=imminent (회고형 정합)', () => {
    expect(decideBoardingPromptFire([{ arvlCd: ARRIVAL_CODE.DEPARTED }])).toEqual({
      fire: true,
      decision: 'imminent',
    });
  });

  it.each([0, 3, 4, 5, 99])('arvlCd=%i만(전부 관측됨) → fire:false, suppressed-not-imminent', (arvlCd) => {
    expect(decideBoardingPromptFire([{ arvlCd }])).toEqual({
      fire: false,
      decision: 'suppressed-not-imminent',
    });
  });

  it('pool 빈 배열 + position 확정 없음 → fire:false', () => {
    expect(decideBoardingPromptFire([])).toEqual({ fire: false, decision: 'suppressed-not-imminent' });
  });

  it('position 확정(positionConfirmed=true)이면 arvlCd가 3이어도 fire:true, decision=position-confirmed', () => {
    expect(decideBoardingPromptFire([{ arvlCd: 3 }], true)).toEqual({
      fire: true,
      decision: 'position-confirmed',
    });
  });

  it('position 확정 + 빈 pool → fire:true, decision=position-confirmed', () => {
    expect(decideBoardingPromptFire([], true)).toEqual({ fire: true, decision: 'position-confirmed' });
  });

  it('arrival 도착(1)과 position 확정이 같이 있으면 imminent가 우선(라벨 안정)', () => {
    expect(decideBoardingPromptFire([{ arvlCd: 1 }], true)).toEqual({ fire: true, decision: 'imminent' });
  });

  it('지하 전부 null → fire:true, decision=fallback-unobservable (miss 재발 방지, equal-protection)', () => {
    expect(decideBoardingPromptFire([{ arvlCd: null }, { arvlCd: null }])).toEqual({
      fire: true,
      decision: 'fallback-unobservable',
    });
  });

  it('혼합(arvlCd=[99, null]) → fallback-unobservable (관측 불가 우선, miss 방지)', () => {
    expect(decideBoardingPromptFire([{ arvlCd: 99 }, { arvlCd: null }])).toEqual({
      fire: true,
      decision: 'fallback-unobservable',
    });
  });

  it('혼합(arvlCd=[5, null]) → 5는 확정이 아니므로 fallback-unobservable', () => {
    expect(decideBoardingPromptFire([{ arvlCd: 5 }, { arvlCd: null }])).toEqual({
      fire: true,
      decision: 'fallback-unobservable',
    });
  });
});

describe('#3057 — boardingPromptFireOnceKey', () => {
  it('trainCode가 있으면 decision을 키에서 제외 — phase만 바뀐 같은 열차는 같은 키(이중 발사 차단)', () => {
    expect(boardingPromptFireOnceKey('용마산', '7325', 'imminent')).toBe('용마산:7325');
    expect(boardingPromptFireOnceKey('용마산', '7325', 'position-confirmed')).toBe('용마산:7325');
  });

  it('다른 열차는 다른 키, trainCode null이면 decision 포함 fallback 키(#2880)', () => {
    expect(boardingPromptFireOnceKey('용마산', '7326', 'imminent')).not.toBe(
      boardingPromptFireOnceKey('용마산', '7325', 'imminent'),
    );
    expect(boardingPromptFireOnceKey('용마산', null, 'imminent')).toBe('용마산:null-trainCode:imminent');
    expect(boardingPromptFireOnceKey('용마산', null, 'position-confirmed')).toBe(
      '용마산:null-trainCode:position-confirmed',
    );
  });
});

describe('#3057 — selectPositionConfirmedTrains', () => {
  const NOW = 1_700_000_000_000;
  const base = { trainCode: 'T1', stationName: '용마산', trainSttus: 1, isUp: false, recptnMs: NOW - 10_000 };
  const inputs = { station: '용마산', direction: 'down' as const, directionUnavailable: false, now: NOW };

  it('anchor 역 + trainSttus 1/2 + fresh + 방향 일치만 통과', () => {
    const positions = [
      base,
      { ...base, trainCode: 'T2', trainSttus: 2 },
      { ...base, trainCode: 'T3', trainSttus: 0 },
      { ...base, trainCode: 'T4', trainSttus: null },
      { ...base, trainCode: 'T5', stationName: '중곡' },
      { ...base, trainCode: 'T6', isUp: true },
      { ...base, trainCode: 'T7', recptnMs: NOW - PROMPT_POSITION_FRESH_MS - 1 },
      { ...base, trainCode: 'T8', recptnMs: 0 },
    ];
    expect(selectPositionConfirmedTrains(positions, inputs).map((p) => p.trainCode)).toEqual(['T1', 'T2']);
  });

  it('direction=up이면 isUp 열차만', () => {
    const positions = [base, { ...base, trainCode: 'T9', isUp: true }];
    expect(
      selectPositionConfirmedTrains(positions, { ...inputs, direction: 'up' }).map((p) => p.trainCode),
    ).toEqual(['T9']);
  });

  it('direction=null: 추론 실패(fail-closed)면 빈 배열, 구조적 unavailable이면 방향 무관 유지', () => {
    const positions = [base, { ...base, trainCode: 'T9', isUp: true }];
    expect(selectPositionConfirmedTrains(positions, { ...inputs, direction: null })).toEqual([]);
    expect(
      selectPositionConfirmedTrains(positions, { ...inputs, direction: null, directionUnavailable: true }).map(
        (p) => p.trainCode,
      ),
    ).toEqual(['T1', 'T9']);
  });
});

describe('#3057 — mergePositionConfirmedIntoPool', () => {
  const feed = (trainCode: string, arvlCd: number | null): ArrivalEntry =>
    ({
      destination: '신풍',
      arrivalSeconds: 120,
      trainCode,
      isUp: false,
      subwayNm: '지하철7호선',
      arvlCd,
    }) as ArrivalEntry;
  const confirmed = (trainCode: string, trainSttus: number, terminus?: string | null) => ({
    trainCode,
    stationName: '용마산',
    trainSttus,
    isUp: false,
    recptnMs: 1,
    ...(terminus === undefined ? {} : { terminus }),
  });

  it('확정 열차가 없으면 pool 그대로', () => {
    const pool = [feed('A', 3)];
    expect(mergePositionConfirmedIntoPool(pool, [], '7')).toEqual(pool);
  });

  it('같은 trainCode면 arvlCd를 position trainSttus로 교정하고 ETA를 0으로', () => {
    const merged = mergePositionConfirmedIntoPool([feed('A', 3), feed('B', 99)], [confirmed('A', 2)], '7');
    expect(merged.map((e) => [e.trainCode, e.arvlCd, e.arrivalSeconds])).toEqual([
      ['A', 2, 0],
      ['B', 99, 120],
    ]);
  });

  it('arrival 피드에 없는 확정 열차는 합성 entry로 추가(terminus 전달)', () => {
    const merged = mergePositionConfirmedIntoPool([], [confirmed('P', 1, '신풍')], '7');
    expect(merged).toEqual([
      {
        destination: '신풍',
        arrivalSeconds: 0,
        trainCode: 'P',
        isUp: false,
        subwayNm: '7호선',
        arvlCd: 1,
        synthesized: true,
        terminus: '신풍',
      },
    ]);
  });

  it('terminus 부재면 빈 destination + terminus=null, 매핑 없는 line은 입력 line 그대로', () => {
    const [entry] = mergePositionConfirmedIntoPool([], [confirmed('P', 2)], 'zz');
    expect(entry.destination).toBe('');
    expect(entry.terminus).toBeNull();
    expect(entry.subwayNm).toBe('zz');
  });
});
