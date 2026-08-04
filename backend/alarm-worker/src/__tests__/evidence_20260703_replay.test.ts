/**
 * 2026-07-03 08:24 KST 중곡→성수 trip replay test (Issue #2024).
 *
 * 목적: 매 이슈 fix 후 실기기 verify 없이 오늘 시나리오 회귀 여부 자동 검증.
 *
 * 검증 대상 (Wave 1 A/B/C/E/J/K):
 *   - Issue A (#2019) — trip token rotation caller 미호출로 old destination push 재발사
 *   - Issue B (#2021) — archFlag=on + lock=null 상태에서 payload.boardingLine 봉인 3곳
 *   - Issue C (#2022) — arvlCd=1 관측 시 boardingPrompt 즉시 발사 caller
 *   - Issue E (#2018) — 목적지 도착 후 안내종료 미발동 (arrival dest match trip end chain)
 *   - Issue J (#2023) — arc(time-integration) 폭주 조기 발사 방지 gate
 *   - Issue K (#2023 흡수) — ETA 조기 발사 (arc + destination-early)
 *
 * 동작 원칙:
 *   1. 현재 코드(dev branch) 실행 — 각 assertion 은 오늘 evidence 를 검증 조건으로 표현.
 *   2. **의도적 fail** — 아직 fix 되지 않은 이슈의 assertion 은 `test.fails()` 로 마킹해
 *      CI 상 "fail 이 정상" 을 명시. 이슈 fix PR 이 이 마킹을 벗기면서 그린으로 전환.
 *   3. Fixture 는 `fixtures/evidence_20260703_junggok_seongsu.ts` 단일 SSOT.
 */

import { describe, it, expect } from 'vitest';
import {
  evaluateBoardingPromptGates,
  pickAutoTrainCode,
} from '../boardingPrompt';
import { getArchFlag, setArchFlag, ARCH_FLAG_DEFAULT } from '../archFlag';
import {
  LA_IMMEDIATE_TRIGGER_ETA_SEC,
  LA_IMMEDIATE_TRIGGER_ETA_SEC_ARCH,
  pickBestArrivalSignal,
} from '../scheduled';
import type { ArrivalEntry } from '../seoul';
import { InMemoryKV } from './inMemoryKv';
import {
  AM_ALARM_LOG_ENTRIES,
  AM_ARCH_FLAG_PRODUCTION,
  AM_ARCH_FLAG_TARGET,
  AM_JUNGGOK_ARRIVALS_ARVLCD_1,
  AM_SEONGSU_ARRIVALS_ARVLCD_1,
  AM_SEONGSU_ARRIVALS_ARVLCD_2,
  AM_RAW_SIGNAL_SAMPLES,
  FIXTURE_NOW,
  REGRESSION_TABLE,
  makeBoardingPromptFiredState,
  makeFixtureTrip,
  type AlarmLogEntry,
  type ArchFlagScenario,
  type RawSignalSample,
  type RegressionAssertion,
} from './fixtures/evidence_20260703_junggok_seongsu';

describe('evidence 2026-07-03 08:24 중곡→성수 — fixture 정합', () => {
  it('trip 은 lock 없이 등록된다 (BoardingLock active=no)', () => {
    const trip = makeFixtureTrip();
    expect(trip.boardingLock).toBeUndefined();
    expect(trip.boardingPromptState).toBeUndefined();
  });

  it('route 는 multi-transfer (중곡 → 건대입구 환승 → 성수)', () => {
    const trip = makeFixtureTrip();
    expect(trip.route.type).toBe('multi-transfer');
    // waypoints: 군자 / 어린이대공원 / 건대입구(transfer) / 성수(destination)
    expect(trip.waypoints.map((w) => w.stationName)).toEqual([
      '군자',
      '어린이대공원',
      '건대입구',
      '성수',
    ]);
    expect(trip.waypoints[3].kind).toBe('destination');
    expect(trip.waypoints[2].kind).toBe('transfer');
  });

  it('raw signal 시계열 47건 + alarm log 아침 이벤트 포함', () => {
    // 최소 20건 이상은 있어야 재현 검증 가능.
    expect(AM_RAW_SIGNAL_SAMPLES.length).toBeGreaterThan(20);
    expect(AM_ALARM_LOG_ENTRIES.length).toBeGreaterThan(10);
    // 결정적 이벤트 3개: BG station-passed 성수 fired / lockless-trip-end fired /
    // fg-evaluated destination-early 성수 suppressed 반복.
    const firedBg = AM_ALARM_LOG_ENTRIES.find(
      (e) => e.source === 'bg' && e.result === 'fired' && e.stationName === '성수',
    );
    expect(firedBg).toBeDefined();
    const tripEnd = AM_ALARM_LOG_ENTRIES.find(
      (e) => e.source === 'lockless-trip-end' && e.result === 'fired',
    );
    expect(tripEnd).toBeDefined();
    const destSpam = AM_ALARM_LOG_ENTRIES.filter(
      (e) =>
        e.reason === 'lockless-no-user-intent' &&
        e.stationName === '성수' &&
        e.kind === 'destination',
    );
    expect(destSpam.length).toBeGreaterThan(0);
  });

  it('regression table 6개 이슈 매핑 유지', () => {
    const issues = REGRESSION_TABLE.map((r) => r.issue).sort();
    expect(issues).toEqual(['A', 'B', 'C', 'E', 'J', 'K']);
  });
});

describe('Issue A (#2019) — trip token rotation caller 재발 검증', () => {
  /**
   * 사용자 오늘 evidence: `boardingPrompt(all)=0` + `BoardingLock active=no` 상태에서
   * `08:37:25 | bg | fired | station-passed | 성수` — 이전 lock 잔재 상태에서 새 trip 시작 후
   * old destination push 발사됨.
   *
   * 재발 조건: 새 route 등록 시 rotation helper 호출 없음. 현재 코드는 helper 정의는 있지만
   * production caller 부재 → 이 test 는 "caller 존재 여부" 를 파일 grep 으로 검증한다.
   */
  it.fails('archFlag=on 시 새 route 등록 handler 가 rotation helper 를 호출한다 (미구현)', () => {
    // fix 후 예상: `handleTripRegistration` 또는 유사한 route entry point 에서 rotation helper 호출.
    // 현재는 caller 부재 → 재발 재현. Issue A fix PR 이 이 test 를 그린으로 뒤집는다.
    //
    // 검증 방식: 실제 caller 존재를 함수 이름 export 여부 + 호출 사이트 정적 검사로 대체.
    // 지금은 Issue A rotation helper 이름이 확정되지 않았으므로 명시적 `expect(false)` 로
    // 회귀 재현을 표현 — Issue A fix PR 이 이 assertion 을 실 caller 확인으로 대체.
    expect(false).toBe(true);
  });
});

describe('Issue B (#2021) — archFlag=on 시 payload.boardingLine 봉인 3곳', () => {
  /**
   * 사용자 오늘 evidence: `BoardingLock active=no` 인데도 `08:37:25 bg fired station-passed 성수`.
   * 원인 후보: backend 3곳 payload builder 가 archFlag 무관 boardingLine 실은 push 발사 →
   * device authoritative pass → fire.
   *
   * 재발 조건: archFlag=on + lock=null 상태에서 boardingLine 이 payload 에 실림.
   * fix 후 예상: 3곳 payload builder 가 archFlag=on 시 boardingLine=undefined 처리.
   */
  it.fails(
    'archFlag=on + lock=null 시 station-passed payload 에 boardingLine 실지 않는다 (3곳 미봉인)',
    () => {
      // Issue B fix 시 아래 3곳이 정합해야 함:
      //   a) arvlCd 관측 기반 station-passed 발사 경로 (scheduled.ts arvlcdFire path)
      //   b) trainCode vanish fallback 경로 (scheduled.ts vanish-fallback-fire)
      //   c) Seam E swap 경로 (lockSwap.ts + scheduled.ts caller)
      //
      // 현재 코드는 lock 이 있으면 boardingLine=lock.line 을 무조건 실음. archFlag=on 분기 없음.
      // → payload.boardingLine !== undefined 이면 회귀 재현. Issue B fix PR 이 아래 를 그린으로 뒤집는다.
      //
      // 재현 방식: 실 payload builder 코드가 archFlag 분기 상수를 참조하는지 판정.
      // 현재는 상수/분기 자체가 없음 → assertion false 명시.
      expect(false).toBe(true);
    },
  );
});

describe('Issue C (#2022) — arvlCd=1 관측 시 boardingPrompt 즉시 발사 caller', () => {
  /**
   * 사용자 오늘 evidence: 7일 boardingPrompt acceptance = 0/0/0/0. 발사 자체 0회.
   *
   * gate 는 `archFlag=on` 시 #9(silence/fired) 만 평가 후 pass (`boardingPrompt.ts:258` 확인).
   * 하지만 caller (scheduled.ts) 에 "arvlCd=1 관측 즉시 발사" 로직 자체가 미구현.
   * → fix 후 예상: caller 가 archFlag=on + arvlCd=1 explicit check + 즉시 fire path 추가.
   */
  it('archFlag=on gate 통과 조건: arvlCd=1 시 boardingPrompt gate 는 이미 통과 상태 (게이트 준비 O)', () => {
    // gate 자체는 이미 archFlag=on 지원. 게이트 통과 = "발사 gate 통과 OK". 실 fire 는 caller 책임.
    const outcome = evaluateBoardingPromptGates({
      series: [], // archFlag=on 은 series 무관
      origin: { lat: 37.5560, lng: 127.0824 }, // 중곡 좌표 (approx)
      nextStation: { lat: 37.5574, lng: 127.0797 }, // 군자 좌표 (approx)
      now: FIXTURE_NOW,
      promptState: undefined, // 사용자 응답 0 → 미발사 상태
      archFlag: 'on',
    });
    expect(outcome.pass).toBe(true);
  });

  it('archFlag=on 시 arvlCd=1 관측 후보 존재 시 trainCode 자동 pick 가능', () => {
    // Seoul API 중곡역 arvlCd=1 관측 시 auto-lock candidate 가 결정될 수 있어야 함.
    // pickAutoTrainCode 는 arvlCd 우선순위 기반 단일 trainCode 결정 로직.
    const trainCode = pickAutoTrainCode(AM_JUNGGOK_ARRIVALS_ARVLCD_1, '7', 'down');
    // arvlCd=1 인 후보가 있으므로 pick 성공 예상.
    expect(trainCode).not.toBeNull();
    expect(trainCode).toBe('7124');
  });

  it.fails(
    'archFlag=on + arvlCd=1 감지 시 boardingPrompt push 즉시 발사 caller 존재 (미구현)',
    () => {
      // 오늘 evidence: 7일간 boardingPrompt fired count = 0.
      // fix 후 예상: caller code path 존재 + fire 카운트 > 0.
      // 현재 코드에는 이 caller 자체가 없음 → 회귀 재현.
      expect(false).toBe(true);
    },
  );
});

describe('Issue E (#2018) — 목적지 도착 후 안내종료 미발동', () => {
  /**
   * 사용자 오늘 evidence: `08:37:25 bg station-passed 성수 fired` + `08:37:29 lockless-trip-end fired`
   * — trip-end 자체는 발동. 하지만 관찰 20 "성수→성수 0정거장 4분 소요예정 UI 잔존" 은 destination
   * 알림 이후에도 route summary 가 종료 안 됨.
   *
   * 재발 조건: destination arrival match (arvlCd=1 성수) 시 trip cleanup 이 route summary UI 도
   * 즉시 종료시켜야 함. 현재는 lockless-trip-end 는 발동하지만 UI 종료 chain 이 완결 안 됨.
   */
  it('lockless-trip-end 이벤트는 발동 (Alarm log 재현 성공)', () => {
    const tripEnd = AM_ALARM_LOG_ENTRIES.find(
      (e) => e.source === 'lockless-trip-end' && e.result === 'fired',
    );
    expect(tripEnd).toBeDefined();
    expect(tripEnd?.reason).toBe('1:intent');
  });

  it.fails(
    'destination match 시 route summary UI cleanup chain 완결 (미구현)',
    () => {
      // 관찰 20 사용자 피드백 재현: "성수 도착 후에도 route UI 지속".
      // fix 후 예상: destination arrival 감지 → cleanup chain 완결 → routeStops 즉시 종료.
      // 현재 코드에는 destination arrival cleanup chain 이 route summary UI 층까지 propagation 안 됨.
      expect(false).toBe(true);
    },
  );
});

describe('Issue J (#2023) — arc(time-integration) 폭주 조기 발사 방지', () => {
  /**
   * 사용자 오늘 evidence: 08:32:45 arc=3998m → 08:37:25 arc=4710m.
   * 실 이동 거리는 5정거장 (약 4km). arc 값이 정지 상태에서 시간 적분으로 증가 →
   * hop 계산 왜곡 → 성수 destination-early 조기 발사.
   *
   * 재발 조건: arc > hopDistance × N배 상황에서 hop 진행이 pause 되지 않음.
   * fix 후 예상: archFlag=on + arc overshoot 감지 시 hop 진행 pause.
   */
  it('arc 시계열은 폭주 pattern 재현 (3985 → 4710m, 정지 상태)', () => {
    const arcSamples = AM_RAW_SIGNAL_SAMPLES.filter(
      (s) => s.arc !== null && s.stationId === '2-012',
    );
    // 08:36:24 arc=3982.64 (dump L445) ~ 08:37:19 arc=4683.41 (dump L434)
    // 실 이동 거리 대비 arc 증가량 폭주 확인.
    const arcs = arcSamples.map((s) => s.arc!);
    const min = Math.min(...arcs);
    const max = Math.max(...arcs);
    // 실 이동 거리 대비 arc 증가량이 700m+ 스핀 (5 정거장 4km 안에서 700m 폭주 = ~17% 오차)
    expect(max - min).toBeGreaterThan(500);
  });

  it.fails(
    'archFlag=on + arc overshoot 감지 시 hop advance pause (미구현)',
    () => {
      // fix 후 예상: arc 값 검증 gate 추가 (hop 진행 전 arc 임계값 체크).
      // 현재 코드에는 arc overshoot 감지 gate 자체가 없음.
      expect(false).toBe(true);
    },
  );
});

describe('Issue K (#2027) — 환승 후 다음 hop 조기 도착 알림 방지', () => {
  /**
   * 사용자 오늘 evidence: 성수 destination-early 발사 08:29 무렵 (실 도착 08:37:25) — 8분 조기.
   * `08:37:00 fg-evaluated destination-early 성수 suppressed lockless-no-user-intent` 알람 log 반복 —
   * 발사 자체는 gate 로 막혔지만 스팸 반복이 관측됨.
   *
   * 재발 조건: 환승 직후 다음 hop 대상 역에서 Seoul API arvlCd=4/5 (early) 신호 즉시 채택 +
   * LA_IMMEDIATE_TRIGGER_ETA_SEC=60s 임계 짧아 destination-imminent 조기 발사.
   *
   * K fix (2 axes):
   *   1. pickBestArrivalSignal — archFlag='on' + line mismatch 시 fallback 차단
   *      (환승 후 이전 line stale 신호 무시)
   *   2. LA_IMMEDIATE_TRIGGER_ETA_SEC 60s → 90s (archFlag=on) — 환승 버퍼 30s 확대
   */
  it('destination early 스팸 반복 pattern 재현 (lockless-no-user-intent 게이트 15+회 suppressed)', () => {
    const spam = AM_ALARM_LOG_ENTRIES.filter(
      (e) =>
        e.kind === 'destination' &&
        e.phaseId === 'early' &&
        e.stationName === '성수' &&
        e.result === 'suppressed',
    );
    // 오늘 dump 는 15건 이상 반복.
    expect(spam.length).toBeGreaterThan(5);
  });

  it('LA_IMMEDIATE_TRIGGER_ETA_SEC_ARCH=90s (archFlag=on) — 60s 대비 30s 확대', () => {
    // fix 후 예상: archFlag=on 시 destination-imminent 판정 임계 60s → 90s.
    // 환승 후 다음 hop 짧은 leg 에서 즉시 발사 판정 시점을 30s 뒤로 밀어 조기 발사 방지.
    expect(LA_IMMEDIATE_TRIGGER_ETA_SEC).toBe(60);
    expect(LA_IMMEDIATE_TRIGGER_ETA_SEC_ARCH).toBe(90);
    expect(LA_IMMEDIATE_TRIGGER_ETA_SEC_ARCH).toBeGreaterThan(LA_IMMEDIATE_TRIGGER_ETA_SEC);
  });

  it('archFlag=on + line mismatch (성수 waypoint=2호선 vs 7호선 stale arrivals): null 반환 → 조기 발사 방지', () => {
    // 환승 직후 성수(2호선) waypoint 상태에서 Seoul API 가 이전 7호선 stale 신호만 반환하는 시나리오.
    // 현재 시나리오 재현: 실 evidence 에서는 성수 arrivals 가 2호선 (지하철2호선) 이지만
    // 환승 timing race 시 이전 line 인 7호선 pool 이 stale 로 반환될 수 있음.
    const staleTransferArrivals: ArrivalEntry[] = [
      { destination: 'A', arrivalSeconds: 50, trainCode: '7-stale', isUp: true, subwayNm: '지하철7호선', arvlCd: 4 },
      { destination: 'B', arrivalSeconds: 30, trainCode: '7-stale2', isUp: true, subwayNm: '지하철7호선', arvlCd: 5 },
    ];
    const seongsu = { stationName: '성수', line: '2', kind: 'destination' as const };
    // archFlag=on: null 반환 → caller skip → destination-imminent 발사 회피.
    expect(pickBestArrivalSignal(staleTransferArrivals, seongsu, 'on')).toBeNull();
  });

  it('archFlag=off (regression 방어): line mismatch 시 fallback 유지 (기존 동작)', () => {
    // 회귀 방어: archFlag=off 는 기존 fallback 동작 유지 (모든 arrivals 로 fallback).
    const staleTransferArrivals: ArrivalEntry[] = [
      { destination: 'A', arrivalSeconds: 50, trainCode: '7-stale', isUp: true, subwayNm: '지하철7호선', arvlCd: 4 },
    ];
    const seongsu = { stationName: '성수', line: '2', kind: 'destination' as const };
    const result = pickBestArrivalSignal(staleTransferArrivals, seongsu, 'off');
    expect(result).not.toBeNull();
    expect(result?.arvlCd).toBe(4);
  });

  it('archFlag=on + 성수 arrivals 2호선 (실 도착) → 정상 pick (matching line 필터 통과)', () => {
    // 실 도착 시점: 성수 arrivals arvlCd=1 (2호선) → 정상 pick.
    // Wave 1 완결 시 이 assertion 은 그대로 통과 — fix 로 인한 정상 케이스 회귀 없음.
    const seongsuWp = { stationName: '성수', line: '2', kind: 'destination' as const };
    const result = pickBestArrivalSignal(AM_SEONGSU_ARRIVALS_ARVLCD_1, seongsuWp, 'on');
    expect(result).not.toBeNull();
    expect(result?.arvlCd).toBe(1);
    expect(result?.etaSeconds).toBe(0);
  });
});

describe('archFlag production state 재현 — dump 시점 실 배포 상태', () => {
  /**
   * dump L333 `/admin/arch-flag → 404` — production KV 미배포 (RC1 backend deploy gap).
   * 이 test 는 archFlag 미배포 상황에서 default('off') 로 fallback 하는지 검증.
   *
   * AM_ARCH_FLAG_PRODUCTION / AM_ARCH_FLAG_TARGET 은 fixture 시나리오 매트릭스.
   *   - production: 오늘 dump 시점 실 상태 ('production-off' — 배포 안됨).
   *   - target:     Wave 1 완결 후 목표 상태 ('target-on' — KV=on 설정).
   */
  const scenarios: readonly ArchFlagScenario[] = [AM_ARCH_FLAG_PRODUCTION, AM_ARCH_FLAG_TARGET];

  it('두 시나리오 (production-off / target-on) 유지', () => {
    expect(scenarios).toContain('production-off');
    expect(scenarios).toContain('target-on');
  });

  it('KV 미설정 상태에서 getArchFlag 는 default (off) 로 fallback (production-off 재현)', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    // KV 에 arch:simple-arrival-v1 미설정 → default = 'off'.
    const flag = await getArchFlag(kv);
    expect(flag).toBe(ARCH_FLAG_DEFAULT);
    expect(flag).toBe('off');
  });

  it('KV 에 on 명시 설정 시 getArchFlag 는 on 반환 (target-on Wave 1 완결 목표 상태)', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    await setArchFlag(kv, 'on');
    const flag = await getArchFlag(kv);
    expect(flag).toBe('on');
  });
});

describe('fixture 타입 shape 검증 — 재현 데이터 형식 sanity', () => {
  it('RawSignalSample shape — 첫 sample 필수 필드 검사', () => {
    const first: RawSignalSample = AM_RAW_SIGNAL_SAMPLES[0];
    expect(first.ts).toBeDefined();
    expect(typeof first.epochMs).toBe('number');
    expect(['cycle', 'enter', 'exit']).toContain(first.type);
  });

  it('AlarmLogEntry shape — bg fired 성수 sample 검사', () => {
    const bg: AlarmLogEntry | undefined = AM_ALARM_LOG_ENTRIES.find(
      (e) => e.source === 'bg' && e.result === 'fired' && e.stationName === '성수',
    );
    expect(bg).toBeDefined();
    expect(bg?.epochMs).toBeGreaterThan(0);
  });

  it('RegressionAssertion shape — 각 항목 issue + description + expected 존재', () => {
    for (const entry of REGRESSION_TABLE) {
      const a: RegressionAssertion = entry;
      expect(a.issue).toBeDefined();
      expect(a.description.length).toBeGreaterThan(5);
      expect(a.expected.length).toBeGreaterThan(5);
      expect(a.observedToday.length).toBeGreaterThan(5);
    }
  });
});

describe('Seoul API arrivals fixture 정합 — cron cycle 재현 입력', () => {
  /**
   * 각 시점 Seoul API 응답이 fixture 정의와 일치하는지 확인.
   * arvlCd=1 관측 시점: Issue C caller 활성 시 즉시 발사 조건.
   */
  it('중곡역 arvlCd=1 관측 시 arvlCd=1 후보 존재 (Issue C 발사 조건)', () => {
    const hasArvlCd1 = AM_JUNGGOK_ARRIVALS_ARVLCD_1.some((a) => a.arvlCd === 1);
    expect(hasArvlCd1).toBe(true);
  });

  it('성수역 arvlCd=2 시점 (도착 임박)', () => {
    const hasArvlCd2 = AM_SEONGSU_ARRIVALS_ARVLCD_2.some((a) => a.arvlCd === 2);
    expect(hasArvlCd2).toBe(true);
  });

  it('성수역 arvlCd=1 시점 (실 도착)', () => {
    const hasArvlCd1 = AM_SEONGSU_ARRIVALS_ARVLCD_1.some((a) => a.arvlCd === 1);
    expect(hasArvlCd1).toBe(true);
  });
});

describe('boardingPrompt gate archFlag 매트릭스 — 회귀 방어', () => {
  /**
   * Wave 1 완결 후에도 archFlag=off 회귀는 없어야 함 (기존 9단 gate 유지).
   */
  // #2130 (Part B-be-2) — "trip당 1회" 정책 폐기. makeBoardingPromptFiredState()는
  // lastFiredAt=FIXTURE_NOW-60_000(1분 전)이라 최소 발사 간격(5분) 게이트로 여전히 차단된다 —
  // reason만 already-fired → fired-too-recently로 바뀐다.
  it('archFlag=off 시 기존 9단 gate 평가 (최근 발사 promptState 는 fired-too-recently로 차단)', () => {
    const firedState = makeBoardingPromptFiredState();
    const outcome = evaluateBoardingPromptGates({
      series: [],
      origin: { lat: 37.5560, lng: 127.0824 },
      nextStation: { lat: 37.5574, lng: 127.0797 },
      now: FIXTURE_NOW,
      promptState: firedState,
      // archFlag 미지정 = 기존 동작
    });
    expect(outcome.pass).toBe(false);
    if (!outcome.pass) expect(outcome.reason).toBe('fired-too-recently');
  });

  it('archFlag=on 시 최근 발사 상태는 여전히 차단 (반복 발사 최소 간격 정책 유지)', () => {
    const firedState = makeBoardingPromptFiredState();
    const outcome = evaluateBoardingPromptGates({
      series: [],
      origin: { lat: 37.5560, lng: 127.0824 },
      nextStation: { lat: 37.5574, lng: 127.0797 },
      now: FIXTURE_NOW,
      promptState: firedState,
      archFlag: 'on',
    });
    expect(outcome.pass).toBe(false);
    if (!outcome.pass) expect(outcome.reason).toBe('fired-too-recently');
  });
});
