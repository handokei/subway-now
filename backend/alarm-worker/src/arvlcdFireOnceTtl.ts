/**
 * arvlCd fire-once TTL helper — ADR-022 Phase 1-1 (#1985).
 *
 * ## 배경
 *
 * ADR-022 (#1980) — Seoul TOPIS `realtimeStationArrival` API (arvlCd) 를 알림 SSOT 로 단일화하는
 * 아키텍처 재설계. Issue #1980 코멘트 "동일 알림 반복 발사 근본 원인" 케이스 2:
 *
 *   13:31:14 silent-push-received 어린이대공원
 *   13:32:14 silent-push-received 어린이대공원   ← 1분 후 또
 *   13:37:14 silent-push-received 어린이대공원   ← 5분 후 또
 *   13:38:14 silent-push-received station-passed imminent 어린이대공원
 *
 * Backend cron 60s 폴링 + arvlCd=1 지속(~30초) — 매 폴링마다 감지 시 push 재발사가 근본 원인.
 *
 * PR #2773 리뷰 보강 #7 — 이 helper 의 존재 근거를 (구)`arvlCdFireKey`(PR #2764 로 삭제)와
 * 대비해 서술하던 과거 버전은 유령 근거였다. 그 dedup 은 애초에 `stationPassedFiredKey`(#2571,
 * 경로 무관 station-passed 단일 마커)가 함수 진입부에서 먼저 검사해 도달불가였음이 확증돼
 * 삭제됐다 — 즉 이 helper 는 (구)`arvlCdFireKey`가 아니라 **`stationPassedFiredKey`와의 목적
 * 차이**로 존재를 정당화해야 한다.
 *
 * `stationPassedFiredKey`(1시간 TTL)는 설계상 "이 역이 이미 발사됐는가"만 본다 — 경로(arvlCd/
 * position/vanish) 무관, arvlCd 값 무관, 무조건 1역당 1회, **성공 fire 직후에만 stamp**. 이
 * fire-once TTL(5분)은 flag=ON 시에만 켜지는 별도 storm guard로, 같은 station 안에서 arvlCd
 * 값이 0→1→2→5 로 monotone 진행하는 cycle **전체**를 단일 fire 이벤트로 묶어 (token, station,
 * cycle bucket) 조합당 1회만 fire 하도록 설계됐다(#1980/#2200 어린이대공원 storm 대응).
 *
 * **미확인 — 다음 감사 항목.** `fireArvlCdStationPush`의 현재 호출 순서(`scheduled.ts`)는
 * `stationPassedFiredKey` 검사가 이 fire-once 체크보다 **먼저** 실행되고, 두 stamp 모두 "성공
 * fire 직후"에만 찍힌다 — 즉 station 최초 fire 성공 이후의 모든 재관측은 이미 stationFiredKey
 * 선검사에서 걸러져 이 fire-once 로직에 도달하지 못할 가능성이 있다(검증 안 함, PR #2764/#2773
 * 범위 밖). 만약 사실이면 이 helper 전체가 #2571 이후 도달불가 후보다 — 단, 이는 이 PR이 만든
 * 변화가 아니라 #2571(2026-09-12) 시점부터의 기존 순서이므로 별도 게이트 감사로 검증할 것.
 * "존재 이유가 없어 보인다"는 추정만으로 삭제하지 말 것 — 이 파일이 겪은 실수(유령 근거 인용)를
 * 반복하지 않는다.
 *
 * ## 정책
 *
 * 같은 (`tripToken`, `stationName`, `cycle`) 조합에서 fire 를 **1회로 강제**. 5분 TTL 로 자연
 * 회수 — TTL 만료 시 다음 관측이 새 cycle 시작 (train 이 물리적으로 같은 station 을 5분 안에
 * 재방문할 수 없음).
 *
 * `cycle` 파라미터는 애초 "미래-확장 slot"으로 설계되어 caller 가 `0` 고정값을 전달했다
 * (arvlCd 0→1→2→5 전체 monotone 시퀀스를 단일 fire 이벤트로 통합 — 어린이대공원 반복 storm
 * 차단, #1985/#2200). #2448 에서 그 확장 slot 을 실제로 활용 — caller(`fireArvlCdStationPush`)
 * 가 `arvlCdFireOnceBucket(arvlCd)`(`scheduled.ts`)로 ENTERING(0)/그 외 2-way bucket 값을
 * 계산해 전달한다. 이 helper 자체는 bucket 의 의미를 모른다 — 여전히 순수 (token, station,
 * cycle) 3-tuple key 저장소일 뿐이며, storm 방지(같은 3-tuple 무제한 재발사 차단)는 그대로다.
 *
 * ## Feature flag
 *
 * 본 helper 자체는 flag 를 알지 않는다 — caller (`fireArvlCdStationPush`) 가 `isSimpleArchEnabled(env)`
 * 로 게이트한다. `isSimpleArchEnabled`는 real `getArchFlag(env.TRIPS)`를 조회한다 (#2201).
 *
 * ## 관측
 *
 * skip 발생 시 caller 가 `writeMetric(env, { eventType: 'suppress', reason: 'fire-once-cycle-already' })`
 * 로 wrangler tail 관측. `arvlCdFireOnceSkipped` stat 카운터도 별도 누적.
 */

import { getArchFlag } from './archFlag';
import type { Env } from './types';

/**
 * 5분 (300s). Train 이 같은 station 을 5분 안에 재방문할 수 없다는 실제 운영 특성 기반.
 * `ARVLCD_FIRE_DEDUP_TTL_SEC` (1시간, 현재는 `stationPassedFiredKey`가 사용) 와 별개 정책 —
 * 이 TTL 은 cycle 단위 전체를 커버하며 flag=ON 시에만 적용된다.
 */
export const ARVLCD_FIRE_ONCE_TTL_SEC = 5 * 60;

/**
 * KV key prefix. 형식: `fireOnce:{tripToken}:{stationName}:{arvlCdCycle}`.
 *
 * 주의: `station-passed-fired:` prefix(`stationPassedFiredKey`, #2571) 와 namespace 격리 —
 * 두 dedup layer 가 동일 KV 에서 서로 오염하지 않는다.
 */
export const ARVLCD_FIRE_ONCE_KEY_PREFIX = 'fireOnce:';

/**
 * Fire-once KV key 빌더.
 *
 * @param token       trip token (per-trip isolation — cross-trip leak 차단).
 * @param stationName waypoint station name (표준 어휘, `stations.json` BLDN_NM).
 * @param cycle       arvlCd cycle bucket (현재는 `0` 고정 slot, 5분 TTL 이 cycle 경계 처리).
 */
export function arvlCdFireOnceKey(
  token: string,
  stationName: string,
  cycle: number,
): string {
  return `${ARVLCD_FIRE_ONCE_KEY_PREFIX}${token}:${stationName}:${cycle}`;
}

/**
 * KV 에 이미 fire-once stamp 가 있는지 확인.
 *
 * @returns true — 이미 fire 됨 (skip 필요). false — 미stamp (fire 진행 가능).
 */
export async function checkArvlCdFireOnce(
  kv: KVNamespace,
  token: string,
  stationName: string,
  cycle: number,
): Promise<boolean> {
  const key = arvlCdFireOnceKey(token, stationName, cycle);
  const existing = await kv.get(key);
  return existing !== null;
}

/**
 * Fire-once stamp 를 5분 TTL 로 write. 성공 fire 직후 caller 가 호출.
 *
 * value 는 stamp 시각 ms — 관측 시 몇 초 전에 stamp 됐는지 tail 에서 즉시 확인.
 */
export async function stampArvlCdFireOnce(
  kv: KVNamespace,
  token: string,
  stationName: string,
  cycle: number,
  now: number,
): Promise<void> {
  const key = arvlCdFireOnceKey(token, stationName, cycle);
  await kv.put(key, String(now), { expirationTtl: ARVLCD_FIRE_ONCE_TTL_SEC });
}

/**
 * ADR-022 Phase 1-1 (#1985) → Phase 1-2 real wire (#2201, ADR-026 Decision 4).
 *
 * `env.TRIPS` KV 의 real `getArchFlag`를 조회 — 'on' 이면 true. 어린이대공원 13:31/13:32/13:37
 * 재발사 (#2200 storm evidence) 는 이 flag가 remote='on' 인데도 항상 `false`를 반환하는
 * 하드코딩 stub 이었던 것이 backend 기여분 근본 원인 — real wire 로 dormant 해제한다.
 *
 * 함수로 노출한 이유: 테스트에서 `vi.spyOn(module, 'isSimpleArchEnabled')` 로 flag=ON 시나리오
 * 검증 가능 유지.
 */
export async function isSimpleArchEnabled(env: Env): Promise<boolean> {
  return (await getArchFlag(env.TRIPS)) === 'on';
}
