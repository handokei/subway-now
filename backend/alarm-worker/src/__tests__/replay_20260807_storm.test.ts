/**
 * 2026-08-07 07:38 KST 뚝섬 storm(동일 알림 반복 발사) replay test — backend side (Issue #2200,
 * ADR-026 #2199). TDD 선행 red fixture — 하위 fix 이슈(#2201/#2202/#2204)가 green으로 flip.
 *
 * ## 재현 대상 (오늘 실기기 dump evidence)
 * dump 상단 Feature Flag 섹션: `env=false remote=on active=ON` — 이 trip은 remote KV
 * `arch:simple-arrival-v1`(ADR-022 Phase 0, #1982)가 **실제로 ON**이다. 그런데 같은 뚝섬 도착
 * 이벤트(arvlCd 0→1 monotone cycle)에 대해 backend visible push + device 로컬 OS 사전예약이
 * 병렬로 발사돼 사용자 체감 배너 3~4회(Alarm log L168~308 dedup-alarm/dedup-station/
 * dedup-channel-agnostic suppressed ~10건 + 실제 fired 2건 이상).
 *
 * ## RCA (backend 기여분)
 * `arvlcdFireOnceTtl.ts`의 `isSimpleArchEnabled()`는 ADR-022 Phase 1-1(#1985) 도입 당시
 * "Phase 0(#1982) 머지 후속 PR에서 real `getArchFlag(env.KV)`로 wire" 예정으로 남겨진 **하드코딩
 * stub**이다(항상 `false` 반환, env/KV 인자 자체가 없음). `archFlag.ts`의 real `getArchFlag(kv)`는
 * 이미 존재하고 이 trip의 remote 값도 실제로 'on'이지만, `fireArvlCdStationPush`의 fire-once
 * cycle 게이트는 이 real flag를 전혀 참조하지 않는다 — 그 결과 같은 (token, station) 조합에서
 * arvlCd가 0→1로 monotone 진행하는 동안(기존 `arvlCdFireKey`는 arvlCd 값마다 별도 entry로 stamp)
 * **두 번 다른 push가 발사**된다. 이것이 storm의 backend 기여분: 물리적으로 한 번뿐인 도착
 * 이벤트에 대해 backend 스스로 2개의 독립적인 visible alert push를 내보낸다.
 *
 * (device 기여분 — OS 사전예약과의 경합 — 은 device 로컬 dedup 계층(crossCategoryStationDedup 등)이
 * 이미 대부분 억제하고 있음을 오늘 dump에서 확인했다(suppressed ~10건). 본 backend 테스트는
 * "단일 물리 이벤트 = 단일 backend emitter" 불변식이 remote flag=ON 상태에서도 깨져 있음을
 * 고정한다.)
 *
 * ## Assert (수리 완료, #2201에서 green으로 flip)
 * 한 물리 도착 이벤트(같은 station의 arvlCd 0→1 monotone 진행)에 대해 backend가 실제로 발사하는
 * visible push 수 = 1 (수리 전 2). #2201이 `isSimpleArchEnabled`를 real
 * `getArchFlag(env.TRIPS)`로 wire해 `it.fails`를 `it`로 교체 — remote flag=ON 상태에서
 * fire-once 게이트가 실제로 관여한다.
 *
 * ## 금지
 * production 코드 수정 없음(테스트만). `scheduled.test.ts`의 fixture 패턴(`makeFullEmptyStats`,
 * `fireArvlCdStationPush` 직접 호출)을 최소 subset으로 재사용해 격리 — vi.spyOn으로 flag=ON을
 * 강제하지 않는다(그 방식은 이미 기존 테스트가 커버). 본 테스트는 real KV에 실제 flag 값을 심어
 * production wiring 자체의 갭을 검증한다.
 */

import { generateKeyPair, exportPKCS8 } from 'jose';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetApnsJwtCache, type ApnsConfig } from '../apns';
import { fireArvlCdStationPush, type ScheduledDeps, type ScheduledStats } from '../scheduled';
import { ARCH_FLAG_KV_KEY } from '../archFlag';
import { putTrip } from '../trips';
import type { BoardingLockMeta, Env, Trip } from '../types';
import { InMemoryKV } from './inMemoryKv';

let apnsConfig: ApnsConfig;

beforeAll(async () => {
  const { privateKey } = await generateKeyPair('ES256');
  const pem = await exportPKCS8(privateKey);
  apnsConfig = {
    keyId: 'K',
    teamId: 'T',
    privateKeyPem: pem,
    bundleId: 'com.example.app',
  };
});

beforeEach(() => resetApnsJwtCache());

// 오늘 dump 명시 시각 — 07:38 KST 뚝섬 phantom/storm evidence.
const NOW = 1_785_887_901_000; // 2026-08-07T07:38:21+09:00 (KST) = 2026-08-06T22:38:21.000Z

const APNS_HOSTS = {
  production: 'api.push.apple.com',
  sandbox: 'api.sandbox.push.apple.com',
} as const;

const TOKEN = 'ddeukseom-storm-tok';

function makeEnv(kv: InMemoryKV): Env {
  return {
    TRIPS: kv as unknown as KVNamespace,
    APNS_HOST: APNS_HOSTS.production,
    APNS_HOST_SANDBOX: APNS_HOSTS.sandbox,
    SEOUL_API_HOST: 'seoul.api',
    SEOUL_API_KEY: 'KEY',
    APNS_KEY_ID: 'K',
    APNS_TEAM_ID: 'T',
    APNS_PRIVATE_KEY: apnsConfig.privateKeyPem,
    APNS_BUNDLE_ID: 'com.example.app',
  };
}

function makeBoardingLock(overrides: Partial<BoardingLockMeta> = {}): BoardingLockMeta {
  return {
    trainCode: '2043',
    line: '2',
    subwayId: '1002',
    selectedDepartureTime: NOW,
    segmentStations: ['건대입구', '뚝섬'],
    expiresAt: NOW + 60 * 60_000,
    ...overrides,
  };
}

function makeTrip(overrides: Partial<Trip> = {}): Trip {
  return {
    token: TOKEN,
    route: { type: 'direct', line: '2', stops: 1 },
    destination: '뚝섬',
    waypoints: [{ stationName: '뚝섬', line: '2', kind: 'destination' }],
    expiresAt: NOW + 60 * 60_000,
    createdAt: NOW,
    alarmAtEpochMs: NOW + 60_000,
    boardingLock: makeBoardingLock(),
    ...overrides,
  };
}

/**
 * `fireArvlCdStationPush` 직접 호출 테스트용 full-shape stats — `scheduled.test.ts`의
 * `makeFullEmptyStats` 재사용(최소 subset, 이 파일 격리 목적으로 복제). `ScheduledStats` 필드
 * 추가 시 두 사이트가 drift 하지 않도록 원본과 동기화 필요.
 */
function makeFullEmptyStats(): ScheduledStats {
  return {
    scanned: 0, polled: 0, pushed: 0, errors: 0, etaMissing: 0, envCorrected: 0,
    lockMissing: 0, boardingAnchorResolved: 0, boardingAnchorUnresolved: 0, laStaleAutoEnded: 0, laStaleSurvivedSilence: 0, killSwitchLocklessIntermediateSkipped: 0, locklessIntermediateFired: 0, locklessMotionGateBlocked: 0,
    laPushSent: 0, laPushFailed: 0, laTokenCleared: 0,
    boardingPromptEvaluated: 0, boardingPromptFired: 0, boardingPromptBlocked: 0,
    phaseImminentBlocked: 0, kalmanReset: 0, kalmanDriftWarning: 0,
    autoLockSuccess: 0, autoLockFalsePositive: 0, boardingPromptAutoDeduped: 0,
    boardingPromptSkippedEmpty: 0, boardingPromptSkippedLockActive: 0, boardingPromptSkippedNoContext: 0, boardingPromptSkippedStale: 0, boardingPromptSkippedTooFar: 0,
    boardingPromptSkippedMinInterval: 0, boardingPromptSkippedMaxFires: 0, boardingPromptSkippedTrainDuplicate: 0,
    hopEndPromptFired: 0, hopEndPromptBlocked: 0, locklessTransferAdvanced: 0, legBoardingPromptFired: 0, legBoardingPromptSkippedWalking: 0, legBoardingPromptBlocked: 0,
    arvlCdFireSuccess: 0, arvlCdFireDedup: 0, arvlCdFireMismatch: 0,
    arvlCdFireBlocked: 0, arvlCdFireFired: 0,
    boardingLockWaypointAdvanceBlocked: 0, transferDestinationGateBlocked: 0,
    vanishFallbackFired: 0, vanishReleaseFired: 0, vanishLocklessTakeover: 0,
    vanishFallbackMotionGateBlocked: 0,
    cronJitterMs: 0, rescheduleBlockedMotion: 0, rescheduleFallbackNoSsot: 0, rescheduleDedupSkipped: 0, destinationBackstopForceEnded: 0, destinationStaleGpsSurvivedSilence: 0,
    realtimePositionFetch: 0, selfPollCacheHit: 0, realtimePositionFetchError: 0,
    stationPollFetch: 0, stationPollCacheHit: 0, stationPollError: 0,
    staleLockFireSkipped: 0,
    arvlCdFireOnceSkipped: 0,
    lifecycleSilenceSkipped: 0, lifecycleForceEnded: 0,
    lifecycleStationarySkipped: 0,
    silentPushFiredByKind: {
      intermediate: 0,
      transfer: 0,
      destination: 0,
      boardingPrompt: 0,
      reschedule: 0,
    },
    scheduleEtaFallback: 0,
    destinationCrossCheck: {
      within: 0,
      gpsFar: 0,
      staleGps: 0,
      noGps: 0,
      stationUnknown: 0,
    },
    pendingActivityPossible: true,
    sleepAlarmFired: 0,
    sleepAlarmDedupSkipped: 0,
    sleepAlarmRolledBack: 0,
    prepareAlarmFired: 0,
    prepareAlarmDedupSkipped: 0,
    prepareAlarmRolledBack: 0,
    etaMissingDemoted: 0,
    trainReconfirmFired: 0,
  };
}

describe('evidence 2026-08-07 07:38 뚝섬 storm — 단일 물리 이벤트 backend 중복 emit (#2200)', () => {
  // #2201 수리 완료 — `isSimpleArchEnabled`가 real `getArchFlag(env.TRIPS)`로 wire되어
  // remote flag='on' 상태에서 같은 (token, station) cycle의 두 번째 arvlCd 관측은 fire-once
  // 게이트로 skip된다. `it.fails` → `it`로 교체 (구 "회귀 확인" 테스트는 수리로 무효화되어 제거).
  it(
    '수리 후 기대치 — 한 물리 도착 이벤트(arvlCd 0→1 monotone) = backend push 1회만 (remote archFlag=on 존중)',
    async () => {
      const kv = new InMemoryKV();
      await kv.put(ARCH_FLAG_KV_KEY, 'on');
      const trip = makeTrip();
      await putTrip(kv as unknown as KVNamespace, trip);
      const apnsFetch = async (): Promise<Response> => new Response('', { status: 200 });
      const commonInputs = {
        trip,
        waypoint: trip.waypoints[0],
        lock: trip.boardingLock!,
        env: makeEnv(kv),
        deps: {
          apnsConfig,
          apnsHosts: APNS_HOSTS,
          fetchImpl: apnsFetch as unknown as typeof fetch,
          now: () => NOW,
        } as ScheduledDeps,
        now: NOW,
        log: () => undefined,
        generatePushId: () => 'p-storm-fix-1',
      };

      const statsFirst = makeFullEmptyStats();
      await fireArvlCdStationPush({ ...commonInputs, stats: statsFirst, arvlCd: 0 });
      expect(statsFirst.arvlCdFireSuccess).toBe(1);

      const statsSecond = makeFullEmptyStats();
      const second = await fireArvlCdStationPush({
        ...commonInputs,
        stats: statsSecond,
        arvlCd: 1,
        generatePushId: () => 'p-storm-fix-2',
      });

      // 수리 후: 같은 물리 이벤트의 두 번째 관측은 fire-once 게이트가 remote flag=on을 존중해
      // skip해야 한다 — 두 번째 push가 발사되지 않는다(dirty=false, arvlCdFireOnceSkipped=1).
      expect(second.dirty).toBe(false);
      expect(statsSecond.arvlCdFireSuccess).toBe(0);
      expect(statsSecond.arvlCdFireOnceSkipped).toBe(1);
    },
  );
});
