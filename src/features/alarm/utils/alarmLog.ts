import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState, type AppStateStatus } from 'react-native';
import { ALARM_LOG_KEY } from '../../../shared/constants/storageKeys';
import { createLogger } from '../../../shared/utils/logger';
import type { AlarmEvent } from './stationAlarm';
import type { AlarmPhaseId } from './alarmPhases';
import type { Station } from '../../../shared/types/station';

// 알람 발사/억제 이벤트를 AsyncStorage ring buffer로 적재한다.
// false alarm 인지(B2) 및 차후 임계값 측정 기반 재조정(A)·GPS+Arrival fusion(C)의
// 측정 인프라. 정책 변경 없이 관찰만 한다.
//
// Buffer 크기는 ALARM_LOG_BUFFER_SIZE 상수로 분리 — 늘리려면 한 곳만 수정.
export const ALARM_LOG_BUFFER_SIZE = 200;

// #735 — appendAlarmLog 배치 정책.
// 기존: 매 호출마다 AsyncStorage RMW(get → parse → push → stringify → set) → JS thread 점유 (10-50ms × N).
// 변경: in-memory pending에 push 후 debounce + max-delay로 1회 RMW 일괄 처리.
//
// FLUSH_DEBOUNCE_MS: 마지막 push로부터 이 시간 동안 추가 push가 없으면 flush.
// FLUSH_MAX_DELAY_MS: 가장 오래된 pending이 이 시간에 도달하면 즉시 flush — 정상 종료가 아닌
//   경로(앱 강제종료, BG task 만료)에서 손실 cap.
//
// AppState 'background'/'inactive' 진입 시 즉시 flush — OS suspend 전 적재 보장.
// silentPushTask는 종료 직전 명시적으로 await flushAlarmLog() 호출 (BG task 시간 제약).
export const FLUSH_DEBOUNCE_MS = 1_000;
export const FLUSH_MAX_DELAY_MS = 5_000;

// 'fg' / 'bg'는 v1 (FG GPS 평가 / BG location task gate). 'fg-evaluated' / 'bg-scheduled'는
// v2 (#372)로 의미 명확화. 두 값 모두 union에 유지해 과거 저장 데이터를 손실 없이 읽는다.
// 'silent-push-received'는 #478 측정 인프라 — silent push 도달 시점 기록.
// 'silent-push-fired'/'silent-push-skipped'는 #478 PR 1-2 — 위치 게이트 통과/실패 발사.
// 'alert-fallback-fired'는 #564 — 채널 2 alert fallback 도달률 측정용.
// (채널 3 Region Monitoring 슬롯은 #593/ADR-007 폐기 → #618에서 제거)
export type AlarmLogSource =
  | 'fg'
  | 'bg'
  | 'fg-evaluated'
  | 'bg-scheduled'
  | 'silent-push-received'
  | 'silent-push-fired'
  | 'silent-push-skipped'
  | 'alert-fallback-fired'
  // #580: useStationAlarm 하이드레이션 1회당 1엔트리. destinationId + 복원된 fired set 크기 기록.
  // 두 번째 fire 직전에 ref가 비워졌는지 직접 관찰 — race 가설 확인용.
  | 'fg-hydrate'
  // #917 A2 follow-up — FG fast path: lock.trainCode arvlCd∈{0,1} 신호로 매역 알림 발사한 케이스.
  // 일반 GPS 기반 fg와 구분해 backend cron silent push 대비 fast path 도달률·정확도 측정.
  | 'fg-arvlcd'
  // #580 M4: firedAlarmsRefDestIdRef vs destination.id mismatch 감지 stamp.
  // ETA/API/FG arvlCd effect 진입 시 refDestId가 destination.id와 다르면 1건 기록.
  // 같은 destinationId에서 mismatch가 반복되면 hydration 완료 전에 effect가 재실행되는 race 정황.
  | 'fg-ref-mismatch'
  // #1021: boardingPrompt 발사 빈도 측정.
  | 'boarding-prompt';
export type AlarmLogOutcome = 'fired' | 'suppressed' | 'received';
// 'dedup-alarm'(#580): evaluateAlarmPhase의 firedAlarms 적중. destination/transfer phase alarm dedup
// 발생 관찰. station-passed는 별도 메커니즘(lastNotifiedStationId)이라 'dedup-station' 사용.
// 'gate-unknown-station' / 'gate-no-location' / 'gate-stale-location' / 'gate-out-of-range'는
// #478 PR 1-2 silent push 위치 게이트 skip 사유.
// 'payload-missing-kind'는 구 백엔드 payload에 kind 필드가 없어 발사 본문 결정 불가 → skip.
// 'lock-line-mismatch'는 BoardingLock 활성 시 nextWaypoint가 lock.boardingLine에 정차하지
// 않는 다른 leg/노선의 silent push로 판정돼 차단된 케이스 (#707).
export type AlarmLogReason =
  | 'dedup-station'
  | 'dedup-alarm'
  // #1515 — station-level cross-category dedup. firedAlarms(phase) + lastNotifiedStationId(station-passed)
  // 분리된 두 dedup 위에 얹은 station 단위 윈도우 dedup. 같은 (destinationId, stationName)이
  // CROSS_CATEGORY_DEDUP_WINDOW_MS 안에 fire되면 후속 카테고리 발사 차단(2026-06-19 성수 회귀).
  | 'dedup-station-unified'
  | 'gate-age'
  | 'gate-accuracy'
  | 'gate-jump'
  // #1291 — BG 알람 경로에서 motionStationary=true(주머니 정지) 확정 시 오발사 차단.
  | 'gate-motion-stationary'
  | 'gate-unknown-station'
  | 'gate-no-location'
  | 'gate-stale-location'
  | 'gate-out-of-range'
  // #1365 — backend `occupiedLine`과 device `estimatorLine` mismatch로 차단된 발사.
  // 환승역(같은 hop index에 line 다른 stop) misfire 차단.
  | 'gate-line-mismatch'
  | 'lock-line-mismatch'
  | 'payload-missing-kind'
  // #727 — 정적 misfire 가드(movementGate.ts)가 차단한 발사.
  // #733 — 'movement-static-position'은 speed 미측정 시 위치 이력(usePositionStability) 기반 정적 차단.
  // #728 — 'movement-motion-stationary'는 CMMotionActivity(iOS) motion=stationary 신호 기반.
  // #1013 — 'movement-motion-warmup'은 fg-hydrate 직후 warmup window 동안 신호 부재 차단.
  | 'movement-no-location'
  | 'movement-stale-timestamp'
  | 'movement-low-accuracy'
  | 'movement-static-speed'
  | 'movement-static-position'
  | 'movement-motion-stationary'
  | 'movement-motion-warmup'
  // #750 — 공통 sleep 룰 게이트(shouldSuppressBySleepRule)가 차단한 발사.
  // scheduler/FG/BG 3개 path 어디서든 같은 reason으로 적재 — 정책 단일 출처.
  | 'sleep-first-transfer'
  // #1236 (Epic #1204 D8 wire) — 같은 게이트가 station-passed 카테고리에서 차단한 발사.
  // transfer 차단(sleep-first-transfer)과 reason을 분리해 D8 station-passed 누수 회귀(2026-06-12 22:11:56 사가정)
  // 차단 횟수를 독립 집계.
  | 'sleep-first-station-passed'
  // #816 C — lockless 분기에서 client 추가 가드가 차단한 발사.
  //   'lockless-non-intermediate': lock 없는 trip에 transfer/destination push 도달 (backend race).
  //   'lockless-opt-out': 사용자 토글 OFF 상태에서 lockless intermediate push 도달.
  | 'lockless-non-intermediate'
  | 'lockless-opt-out'
  // #746 — 사용자가 알람을 dismiss한 직후 5분 또는 200m 이내 동안 모든 카테고리 차단.
  | 'dismiss-silence'
  | 'gate-phase-accuracy'
  | 'gate-phase-warmup'
  // #1010 — station-passed effect가 lock hydrate 직후 30s warmup window 동안 차단된 발사.
  | 'gate-station-passed-warmup'
  // #1208 (Epic #1204 D2) — station-passed가 trip 진행도 hop window 밖이라 차단된 발사.
  // currentHopIndex ± windowSize 범위 밖 candidate station을 fire 차단 — 사가정/성수 회귀 evidence.
  // 'gate-hop-window-no-source'는 hop SSOT(estimator/lock/firedAlarms)가 모두 없어 게이트 미적용 graceful skip 적재.
  | 'gate-hop-window'
  | 'gate-hop-window-no-source'
  // #1514 — lockless trip의 출발역 자기 자신(arc[0])에서 currentHopIndex=0일 때 차단된 발사.
  // 2026-06-19 용마산 evidence: lockless 또는 lock fetch 부재 상태에서 origin hop window가
  // candidate=0을 허용해 "출발역 도착" false fire 발생. lock 활성 trip은 본 가드 미적용
  // (boardingStationId 기준 startStation 진행 알림은 정당 — ADR-014 §4 동급 보장).
  | 'gate-origin-hop-lockless'
  // #1012 (H5) — useStationAlarm hydration state machine 각 phase 진입 stamp.
  // pre-hydrate → hydrating → storage-synced → ready 4단계. 'ready' 전 phase에서는
  // 모든 phase 알람 발사가 보류된다. transition 한 번에 1엔트리 적재 — 운영에서 phase
  // 도달 시점·체류 시간 분포 측정.
  | 'hydration-pre-hydrate'
  | 'hydration-hydrating'
  | 'hydration-storage-synced'
  | 'hydration-ready'
  // #918 A3 PR2 (#729 흡수) — `tba:` 사전 예약 알람 fire-time 재검증 실패.
  //   'revalidate-no-trip': tripStart 미존재(이미 종료된 trip의 잔여 발화).
  //   'revalidate-route-sig-mismatch': 예약 시점 sig와 현재 sig 불일치(목적지 변경/환승 재산정).
  //   'revalidate-waypoint-mismatch': 파싱된 stationName이 현재 route waypoint에 없음.
  | 'revalidate-no-trip'
  | 'revalidate-route-sig-mismatch'
  | 'revalidate-waypoint-mismatch'
  // #1167 — boardingPrompt [탑승] 응답 → arvlCd 우선순위 autoLock 결과.
  //   'autolock-success': arvlCd 우선순위로 1대 확정 → createLock 성공.
  //   'autolock-no-trip': destinationId null (사용자 trip 종료 후 늦은 탭).
  //   'autolock-arrivals-empty': fetchArrivalsForStation null/no candidates.
  //   'autolock-ambiguity': 같은 priority 후보 2+ → manual fallback.
  //   'autolock-station-lookup': originStation/line 매칭 실패.
  //   'autolock-lock-failed': createLock 예외 (저장/네트워크 등) → manual fallback.
  | 'autolock-success'
  | 'autolock-no-trip'
  | 'autolock-arrivals-empty'
  | 'autolock-ambiguity'
  | 'autolock-station-lookup'
  | 'autolock-lock-failed'
  // #1170 — boarding-prompt 사용자 응답 측정. 9단 게이트 통과 후 발사된 prompt에 대한 응답.
  //   'response-boarded': [탑승] 또는 default 탭 액션.
  //   'response-dismissed': [미탑승] 또는 dismiss.
  | 'response-boarded'
  | 'response-dismissed'
  // #1357 (S1) — preschedule 진입 시 motion=stationary 확정으로 사전예약 schedule을 skip한 경우.
  // boardingLock/lockless 양쪽 path 공통. OS scheduleNotificationAsync 0회로 정적 trip 시작의
  // 첫 banner 발사를 차단한다. share dump에서 'schedule-skipped-motion-stationary' 카운트로 추적.
  | 'schedule-skipped-motion-stationary'
  // #1399 — backend가 push에 stamp한 tripToken이 device ACTIVE_TRIP_KEY와 mismatch.
  // 좀비 알림 cleanup: trip 종료 후 늦게 도착한 stale silent push 발사 차단(S8 14:19 회귀).
  | 'trip-token-mismatch';
export type AlarmLogKind = 'destination' | 'transfer' | 'station-passed';
export type AlarmLogDirection = 'up' | 'down';
// #396 — imminent 발사 신호 출처. 'api'는 도착정보 arrivalCode 신호, 'eta'는 기존 ETA 임계.
// early phase 등 imminent 외 발사에선 미설정.
export type AlarmLogTrigger = 'api' | 'eta';

export interface AlarmLogLocation {
  lat: number;
  lng: number;
  accuracy: number | null;
  ageMs: number;
}

/**
 * 사전 예약 알람에 첨부되는 컨텍스트 stamp (#372).
 * "이 알람이 어떤 입력값으로 산출됐는가?"를 발사 시점 진단 없이도 알 수 있게 한다.
 *
 * 모든 필드는 null 허용 — caller가 모르면 그대로 null. (예: silent push BG는
 * 방향/trainCode를 모른다.)
 *
 * 시점 주의:
 *   - 사전 예약 알람은 expo-notifications OS 레벨로 발사되므로 fire-time hook이 없다.
 *   - 따라서 `actualLastNotifiedStation`은 발사 시점 값이 아닌 **예약 시점 스냅샷**이다.
 *   - 이름은 이슈 #372 스펙(`actualLastNotifiedStation`)을 유지하지만, 진단 시
 *     "예약 직후 알고 있던 가장 최신 위치"로 해석해야 한다.
 */
export interface AlarmLogStamp {
  direction: AlarmLogDirection | null;
  usedTrainCode: string | null;
  selectedArrivalSeconds: number | null;
  expectedStationAtFire: string | null;
  actualLastNotifiedStation: string | null;
}

export interface AlarmLogEntry {
  ts: number;
  source: AlarmLogSource;
  outcome: AlarmLogOutcome;
  reason?: AlarmLogReason;
  stationName?: string;
  kind?: AlarmLogKind;
  phaseId?: AlarmPhaseId;
  location?: AlarmLogLocation;
  // #372 — 사전 예약 알람 stamp. 모두 optional (구버전/일부 caller 호환).
  direction?: AlarmLogDirection | null;
  usedTrainCode?: string | null;
  selectedArrivalSeconds?: number | null;
  expectedStationAtFire?: string | null;
  actualLastNotifiedStation?: string | null;
  // #478 — silent push 측정 인프라. silent-push-received 엔트리에서만 사용.
  // sentAt: 백엔드 발사 시점(payload), receivedAt: 클라 수신 시점.
  // 두 시각 차로 도달 지연 분포 측정.
  sentAt?: number;
  receivedAt?: number;
  // #396 — imminent phase 발사 trigger 출처. 미설정은 트리거 무관(early 등) 또는 구버전 로그.
  trigger?: AlarmLogTrigger;
  // #478 PR 1-2 — silent push 위치 게이트 결과.
  // silent-push-fired / silent-push-skipped 엔트리에서 사용.
  distanceM?: number;
  thresholdM?: number;
  locationSource?: 'cache' | 'fresh';
  locationAgeMs?: number;
  // #580: fg-hydrate 엔트리 — destinationId + 복원된 fired set 크기.
  destinationId?: string | null;
  firedAlarmsCount?: number;
  // #580 M4: fg-ref-mismatch 엔트리 — 예상 destinationId와 실제 refDestId 기록.
  refDestId?: string | null;
  // #1024 — burst inline counter. 같은 reason 연속 발생 시 count++ (새 entry 추가 대신).
  // 미설정이면 1로 해석 — 기존 entry와 완전 하위 호환.
  count?: number;
  // #1208 (Epic #1204 D2) — hop window 게이트 적재 시 진단 컨텍스트.
  // currentHopIndex = D1 estimator/fallback이 결정한 SSOT hop, candidateIndex = arc 위 candidate 위치.
  currentHopIndex?: number;
  candidateIndex?: number;
}

const logger = createLogger('AlarmLog');

// ── 적재 helper ──
// 호출자는 `void log*(...)` 한 줄로 적재한다. ts/source/outcome 등 필드는
// helper가 채운다 — 호출부에서 누락하거나 잘못 채우는 사고를 차단.
// 모든 helper는 fire-and-forget: 실패해도 후속 정합성에 영향 없음(이미 swallow).

export function logFiredAlarm(
  source: AlarmLogSource,
  event: AlarmEvent,
  trigger?: AlarmLogTrigger,
): void {
  appendAlarmLog({
    ts: Date.now(),
    source,
    outcome: 'fired',
    stationName: event.stationName,
    kind: event.type,
    phaseId: event.phaseId,
    trigger,
  });
}

/**
 * 사전 예약(BG) 알람 1건의 stamp 컨텍스트를 적재한다 (#372).
 * source는 항상 'bg-scheduled', outcome은 'fired'(사전 예약된 발사 예정 기록).
 * 발사 자체는 expo-notifications가 처리하므로 별도 fire-time 로그는 없다.
 */
export function logScheduledAlarm(event: AlarmEvent, stamp: AlarmLogStamp): void {
  appendAlarmLog({
    ts: Date.now(),
    source: 'bg-scheduled',
    outcome: 'fired',
    stationName: event.stationName,
    kind: event.type,
    phaseId: event.phaseId,
    direction: stamp.direction,
    usedTrainCode: stamp.usedTrainCode,
    selectedArrivalSeconds: stamp.selectedArrivalSeconds,
    expectedStationAtFire: stamp.expectedStationAtFire,
    actualLastNotifiedStation: stamp.actualLastNotifiedStation,
  });
}

export function logFiredStationPassed(source: AlarmLogSource, station: Station): void {
  appendAlarmLog({
    ts: Date.now(),
    source,
    outcome: 'fired',
    stationName: station.name,
    kind: 'station-passed',
  });
}

/**
 * #1515 — cross-category station-level dedup 적중 1건 적재.
 *
 * 같은 (destinationId, stationName)이 CROSS_CATEGORY_DEDUP_WINDOW_MS 안에 fire된 station에
 * destination/transfer/station-passed 어느 카테고리든 후속 발사를 차단한 케이스.
 * burst dedup 윈도우로 같은 (source, stationName) 반복 로그는 1건만 적재.
 */
export function logSuppressedCrossCategoryDedup(input: {
  source: AlarmLogSource;
  stationName: string;
  kind: AlarmLogKind;
  phaseId?: AlarmPhaseId;
}): void {
  if (isBurstDuplicate('dedup-station-unified', input.stationName)) return;
  appendAlarmLog({
    ts: Date.now(),
    source: input.source,
    outcome: 'suppressed',
    reason: 'dedup-station-unified',
    stationName: input.stationName,
    kind: input.kind,
    phaseId: input.phaseId,
  });
}

export function logSuppressedDedupStation(source: AlarmLogSource, station: Station): void {
  if (isBurstDuplicate('dedup-station', station.name)) return;
  appendAlarmLog({
    ts: Date.now(),
    source,
    outcome: 'suppressed',
    reason: 'dedup-station',
    stationName: station.name,
    kind: 'station-passed',
  });
}

/**
 * #580: useStationAlarm 하이드레이션 1회당 1엔트리. dedup race 진단용.
 *
 * 두 번째 fire 발생 시점 직전에 ref가 비워졌는지(=fired set이 비어있었는지) 직접 관찰한다.
 * 정상 동작: 하이드레이션 후 firedAlarmsCount는 이전 trip의 fired 누적치(>0)이거나 0(새 trip).
 * 회귀 패턴: fire 이후 destinationId 변동 없이 다시 0이 찍히면 storage write 손실/race 정황.
 */
export function logFiredAlarmsHydrate(destinationId: string | null, firedAlarmsCount: number): void {
  appendAlarmLog({
    ts: Date.now(),
    source: 'fg-hydrate',
    outcome: 'received',
    destinationId,
    firedAlarmsCount,
  });
}

/**
 * #580 M4: firedAlarmsRefDestIdRef mismatch 1건 적재.
 *
 * ETA/API imminent/FG arvlCd 3개 effect 진입 시 ref가 가리키는 destinationId(refDestId)가
 * 현재 destination.id(destinationId)와 다를 때 호출된다.
 *
 * 정상 동작: destination 전환 직후 hydration 완료 전에만 발생 → hydration 완료되면 소멸.
 * 회귀 패턴: 같은 destinationId에서 mismatch가 반복되면 hydration이 완료되지 않거나 ref가
 * 잘못 갱신되는 race 정황.
 *
 * in-memory time-window dedup (#626 패턴). ETA/API effect가 GPS fix마다 재실행되므로
 * dedup 없이는 hydration 창 동안 수백 건이 적재돼 ring buffer를 가득 채운다.
 * 같은 (destinationId, refDestId) 쌍이 DEDUP_LOG_WINDOW_MS 안에 재호출되면 drop.
 */
const lastRefMismatchTs = new Map<string, number>();

export function logRefMismatch(destinationId: string, refDestId: string | null): void {
  const now = Date.now();
  const key = `${destinationId}|${refDestId}`;
  const last = lastRefMismatchTs.get(key);
  if (last !== undefined && now - last < DEDUP_LOG_WINDOW_MS) return;
  lastRefMismatchTs.set(key, now);
  appendAlarmLog({
    ts: now,
    source: 'fg-ref-mismatch',
    outcome: 'suppressed',
    destinationId,
    refDestId,
  });
}

/** 테스트 전용 — refMismatch 윈도우 캐시 리셋. */
export function _resetRefMismatchWindowForTests(): void {
  lastRefMismatchTs.clear();
}

/**
 * #580: phase alarm dedup 적중 1건 적재. destination/transfer phase가 firedAlarms로
 * 이미 발화된 것을 evaluateAlarmPhase가 인지해 재발화하지 않을 때 호출.
 * 발사 횟수 vs dedup 횟수 비율로 dedup이 정상 동작 중인지 운영 데이터로 확인 가능.
 *
 * #626: in-memory time-window dedup. FG polling cycle이 매초 같은 phase를 평가해
 * dedup-alarm 로그가 alarmLog 버퍼를 채우는 회귀 차단 (alarmLog 46개 중 41개가 같은
 * 이벤트인 케이스 관측). 같은 (source/type/phaseId/stationName)이 DEDUP_LOG_WINDOW_MS
 * 안에 재호출되면 drop — dedup이 동작 중인지 운영 신호는 첫 1건으로 충분.
 *
 * 키에 type 포함 — 환승역에서 같은 phaseId가 destination/transfer 두 type으로 동시
 * 평가될 때 한쪽이 다른 쪽을 silence하지 않게 (실제 firedAlarms도 type까지 구분함).
 */
export const DEDUP_LOG_WINDOW_MS = 5_000;
const lastDedupLogTs = new Map<string, number>();

/**
 * Map 무한 성장 방지. size가 cap을 넘으면 윈도우 만료된 엔트리 일괄 정리.
 * 정상 trip(소스 × type × phase × 역 ~수십)에선 트리거 안 됨 — 비정상 입력 안전망.
 */
const DEDUP_LOG_MAP_CAP = 64;
function sweepExpiredDedupEntries(now: number): void {
  if (lastDedupLogTs.size <= DEDUP_LOG_MAP_CAP) return;
  for (const [k, ts] of lastDedupLogTs) {
    if (now - ts >= DEDUP_LOG_WINDOW_MS) lastDedupLogTs.delete(k);
  }
}

export function logSuppressedDedupAlarm(
  source: AlarmLogSource,
  event: Pick<AlarmEvent, 'phaseId' | 'type' | 'stationName'>,
): void {
  const now = Date.now();
  const key = `${source}|${event.type}|${event.phaseId}|${event.stationName}`;
  const last = lastDedupLogTs.get(key);
  if (last !== undefined && now - last < DEDUP_LOG_WINDOW_MS) return;
  lastDedupLogTs.set(key, now);
  sweepExpiredDedupEntries(now);
  appendAlarmLog({
    ts: now,
    source,
    outcome: 'suppressed',
    reason: 'dedup-alarm',
    stationName: event.stationName,
    kind: event.type,
    phaseId: event.phaseId,
  });
}

/** 테스트용 — 윈도우 캐시 리셋. */
export function _resetDedupAlarmWindowForTests(): void {
  lastDedupLogTs.clear();
}

/**
 * #1023: burst-prone 5 reason (movement-* 3종 + dedup-station + movement-low-accuracy)용
 * in-memory time-window dedup.
 *
 * logSuppressedDedupAlarm과 동일한 DEDUP_LOG_WINDOW_MS / DEDUP_LOG_MAP_CAP 정책을 공유한다.
 * 키: `${reason}|${stationName}` — 같은 역의 같은 reason 반복 스팸 차단.
 * stationName까지 구분해야 역이 바뀌었을 때 첫 신호를 drop하지 않는다.
 */
const lastBurstSuppressTs = new Map<string, number>();

function sweepExpiredBurstEntries(now: number): void {
  if (lastBurstSuppressTs.size <= DEDUP_LOG_MAP_CAP) return;
  for (const [k, ts] of lastBurstSuppressTs) {
    if (now - ts >= DEDUP_LOG_WINDOW_MS) lastBurstSuppressTs.delete(k);
  }
}

function isBurstDuplicate(reason: string, stationName: string): boolean {
  const now = Date.now();
  const key = `${reason}|${stationName}`;
  const last = lastBurstSuppressTs.get(key);
  if (last !== undefined && now - last < DEDUP_LOG_WINDOW_MS) return true;
  lastBurstSuppressTs.set(key, now);
  sweepExpiredBurstEntries(now);
  return false;
}

/** 테스트용 — burst dedup 윈도우 캐시 리셋. */
export function _resetBurstSuppressWindowForTests(): void {
  lastBurstSuppressTs.clear();
}

/**
 * #1545 (S12) — trip 종료 시 3개 dedup 윈도우 Map을 모두 클리어.
 *
 * 사용자가 직전 trip에서 동일 destination/같은 phaseId를 가진 새 trip을 즉시 시작하면,
 * 5s 윈도우 안의 lastDedupLogTs / lastBurstSuppressTs / lastRefMismatchTs 엔트리가
 * 새 trip의 정상 신호를 silence할 수 있다. trip 경계에서 3개 Map을 함께 비워 다음
 * trip이 깨끗한 상태로 시작하도록 보장. `TRIP_BOUND_CLEANUPS`에 wiring (BG silent push
 * trip-ended 경로 + FG setDestination(null/switch) 양쪽 커버).
 *
 * 멱등 — 빈 Map에서도 graceful no-op.
 */
export function clearAlarmLogWindows(): Promise<void> {
  lastRefMismatchTs.clear();
  lastDedupLogTs.clear();
  lastBurstSuppressTs.clear();
  return Promise.resolve();
}

/**
 * silent push 수신 1건 적재 (#478 측정 인프라).
 * sentAt(백엔드 payload)와 receivedAt(클라 수신 시점) 차로 도달 지연 측정.
 * sentAt이 없으면(구 백엔드) undefined로 기록 — 추후 백엔드 배포 전후 분리 분석 가능.
 * 동작 변경 없음 — 데이터만 모은다.
 */
export function logSilentPushReceived(input: {
  stationName: string;
  kind: AlarmLogKind | 'intermediate' | undefined;
  phaseId: AlarmPhaseId;
  sentAt: number | undefined;
  receivedAt: number;
}): void {
  // 'intermediate'는 station-passed에 매핑 (#416 silent push intermediate 흐름).
  // kind 미상(구 백엔드)이면 kind 필드 자체를 비워둔다.
  const mappedKind: AlarmLogKind | undefined =
    input.kind === 'intermediate' ? 'station-passed' : input.kind;
  appendAlarmLog({
    ts: input.receivedAt,
    source: 'silent-push-received',
    outcome: 'received',
    stationName: input.stationName,
    kind: mappedKind,
    phaseId: input.phaseId,
    sentAt: input.sentAt,
    receivedAt: input.receivedAt,
  });
}

/**
 * Reschedule silent push 수신 1건 적재 (#725).
 *
 * 일반 silent push와 source가 같지만(`silent-push-received` — DebugModal `lastReceivedAt`이
 * 자동 갱신되도록), kind/phaseId는 reschedule 의미상 미적용. 추적은 stationName(=nextStation)과
 * sentAt/receivedAt 지연 측정으로 충분.
 *
 * 별도 helper로 분리한 이유: AlarmLogKind/AlarmPhaseId 타입에 'reschedule'을 끼워 넣으면
 * 호출자(다른 logSilentPush*)에 cascade 영향이 발생. 분리하면 reschedule만 isolated 경로.
 */
export function logSilentPushRescheduleReceived(input: {
  nextStation: string;
  sentAt: number | undefined;
  receivedAt: number;
}): void {
  appendAlarmLog({
    ts: input.receivedAt,
    source: 'silent-push-received',
    outcome: 'received',
    stationName: input.nextStation,
    sentAt: input.sentAt,
    receivedAt: input.receivedAt,
  });
}

/**
 * Trip-ended silent push 수신 1건 적재 (#868).
 *
 * server-side trip auto-end 신호. 일반 silent push와 source는 같지만 station/kind/phaseId 모두 무의미
 * (trip 자체가 종료되므로 다음 역 컨텍스트 없음). reason은 stationName 자리에 인코딩해 DebugModal에서
 * 가시화 — alarmLog schema에 새 reason 필드를 더하지 않고 기존 슬롯을 재사용한다.
 */
export function logSilentPushTripEndedReceived(input: {
  reason: string;
  sentAt: number | undefined;
  receivedAt: number;
}): void {
  appendAlarmLog({
    ts: input.receivedAt,
    source: 'silent-push-received',
    outcome: 'received',
    stationName: `trip-ended:${input.reason}`,
    sentAt: input.sentAt,
    receivedAt: input.receivedAt,
  });
}

/**
 * silent push가 위치 게이트 통과 → 즉시 발사한 1건 (#478 PR 1-2).
 */
export function logSilentPushFired(input: {
  stationName: string;
  kind: AlarmLogKind;
  phaseId: AlarmPhaseId;
  distanceM: number;
  thresholdM: number;
  locationSource: 'cache' | 'fresh';
  locationAgeMs: number;
}): void {
  appendAlarmLog({
    ts: Date.now(),
    source: 'silent-push-fired',
    outcome: 'fired',
    stationName: input.stationName,
    kind: input.kind,
    phaseId: input.phaseId,
    distanceM: input.distanceM,
    thresholdM: input.thresholdM,
    locationSource: input.locationSource,
    locationAgeMs: input.locationAgeMs,
  });
}

/**
 * silent push 위치 게이트 실패 → 발사 skip 한 1건 (#478 PR 1-2).
 * reason은 게이트 사유: gate-unknown-station / gate-no-location /
 * gate-stale-location / gate-out-of-range.
 */
export function logSilentPushSkipped(input: {
  stationName: string;
  kind: AlarmLogKind | undefined;
  phaseId: AlarmPhaseId;
  reason: AlarmLogReason;
  distanceM?: number;
  thresholdM?: number;
  locationSource?: 'cache' | 'fresh';
  locationAgeMs?: number;
}): void {
  appendAlarmLog({
    ts: Date.now(),
    source: 'silent-push-skipped',
    outcome: 'suppressed',
    reason: input.reason,
    stationName: input.stationName,
    kind: input.kind,
    phaseId: input.phaseId,
    distanceM: input.distanceM,
    thresholdM: input.thresholdM,
    locationSource: input.locationSource,
    locationAgeMs: input.locationAgeMs,
  });
}

/**
 * 채널 2 alert fallback 발사 1건 적재 (#564).
 * 백엔드 ACK 타임아웃 후 alert push가 전달돼 발사된 경우. silent push와 다르게
 * 클라 위치 게이트 없이 OS가 즉시 표시하므로 distance/threshold는 기록하지 않는다.
 */
export function logAlertFallbackFired(input: {
  stationName: string;
  kind: AlarmLogKind;
  phaseId: AlarmPhaseId;
}): void {
  appendAlarmLog({
    ts: Date.now(),
    source: 'alert-fallback-fired',
    outcome: 'fired',
    stationName: input.stationName,
    kind: input.kind,
    phaseId: input.phaseId,
  });
}

/**
 * 로그 엔트리들을 source별로 카운트한다 (#564).
 * DebugModal 헤더/dump에 채널별 도달률 요약을 표기하기 위한 측정 인프라.
 * 결과는 카운트가 0이 아닌 source만 포함 — 노이즈 줄이고 새 source가 추가돼도
 * 코드 수정 없이 자동 반영된다 (UI는 데이터 주도).
 */

/**
 * 게이트/reason별 억제 횟수를 집계한다 (#1019).
 */
export function summarizeAlarmLogByReason(entries: readonly AlarmLogEntry[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const e of entries) {
    if (e.outcome !== 'suppressed') continue;
    const key = e.reason ?? '(unknown)';
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

export function summarizeAlarmLogBySource(
  entries: readonly AlarmLogEntry[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of entries) {
    counts[entry.source] = (counts[entry.source] ?? 0) + 1;
  }
  return counts;
}

export interface AlarmLogReasonCounter {
  reason: string;
  count: number;
  lastTs: number;
}

/**
 * reason별 누적 count + 마지막 발생 시각 집계 (#1024).
 * suppressed 엔트리의 count 필드(미설정 시 1로 해석)를 합산하고 마지막 ts를 추적한다.
 * DebugModal ## Counters 섹션에서 어떤 reason이 얼마나 자주 억제됐는지 시각화용.
 * count 내림차순으로 정렬해 반환 — 가장 빈번한 reason이 상단에 노출.
 */
export function summarizeAlarmLogCounters(
  entries: readonly AlarmLogEntry[],
): AlarmLogReasonCounter[] {
  const map = new Map<string, AlarmLogReasonCounter>();
  for (const entry of entries) {
    if (entry.outcome !== 'suppressed') continue;
    const key = entry.reason ?? '(unknown)';
    const entryCount = entry.count ?? 1;
    const existing = map.get(key);
    if (existing) {
      existing.count += entryCount;
      if (entry.ts > existing.lastTs) existing.lastTs = entry.ts;
    } else {
      map.set(key, { reason: key, count: entryCount, lastTs: entry.ts });
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

/**
 * Silent push outcome별 집계 (#856).
 *
 * DebugModal Silent Push 섹션에서 "lastRecv 시간만 보고 왜 안 울리지?" 의문을 해소하기 위한
 * UX 보조 카운트. `summarizeAlarmLogBySource`와 별개로 silent push 3개 source만 좁혀 집계.
 *
 * - `received`: backend가 보낸 silent push 도달 횟수 (`silent-push-received`)
 * - `fired`: 위치 게이트 통과해 실제 알림이 노출된 횟수 (`silent-push-fired`)
 * - `skipped`: 위치 게이트 실패로 발사 안 한 횟수 (`silent-push-skipped`)
 *
 * 새 silent push source가 추가되면 SILENT_PUSH_OUTCOME_SOURCES 맵에 한 줄만 더하면
 * 자동 반영 (글로벌 룰 3 — 데이터 주도).
 */
const SILENT_PUSH_OUTCOME_SOURCES: Record<AlarmLogSource, keyof SilentPushOutcomeCounts | null> = {
  'silent-push-received': 'received',
  'silent-push-fired': 'fired',
  'silent-push-skipped': 'skipped',
  fg: null,
  bg: null,
  'fg-evaluated': null,
  'bg-scheduled': null,
  'alert-fallback-fired': null,
  'fg-hydrate': null,
  'fg-arvlcd': null,
  'fg-ref-mismatch': null,
  'boarding-prompt': null,
};

export interface SilentPushOutcomeCounts {
  received: number;
  fired: number;
  skipped: number;
}

export function countSilentPushOutcomes(
  entries: readonly AlarmLogEntry[],
): SilentPushOutcomeCounts {
  const counts: SilentPushOutcomeCounts = { received: 0, fired: 0, skipped: 0 };
  for (const entry of entries) {
    const bucket = SILENT_PUSH_OUTCOME_SOURCES[entry.source];
    if (bucket !== null) counts[bucket] += 1;
  }
  return counts;
}

export function logSuppressedGate(
  reason: 'gate-age' | 'gate-accuracy' | 'gate-jump' | 'gate-motion-stationary',
  location: AlarmLogLocation,
): void {
  appendAlarmLog({
    ts: Date.now(),
    source: 'bg',
    outcome: 'suppressed',
    reason,
    location,
  });
}

/**
 * FG phase ETA effect의 진입 게이트 차단 1건 적재 (#1019).
 * 'gate-phase-accuracy': isAccuracyAcceptable(accuracyMeters) 실패.
 * 'gate-phase-warmup': 첫 trigger suppress (warmup window).
 * isBurstDuplicate로 DEDUP_LOG_WINDOW_MS 안의 같은 reason+station 중복 drop.
 */
export function logSuppressedPhaseGate(reason: 'gate-phase-accuracy' | 'gate-phase-warmup', stationName: string | undefined): void {
  const name = stationName ?? '(unknown)';
  if (isBurstDuplicate(reason, name)) return;
  appendAlarmLog({ ts: Date.now(), source: 'fg-evaluated', outcome: 'suppressed', reason, stationName: name });
}

/**
 * 정적 misfire 가드(movementGate.ts)가 차단한 발사 1건 적재 (#727).
 * source는 호출자에 따라 fg/silent-push-skipped/bg-scheduled 등 — 정적 회귀의 출처를 좁히기 위해.
 * stationName/kind/phaseId는 차단된 알람 컨텍스트. reason은 'movement-*' 4종 중 하나.
 */
export function logSuppressedMovement(input: {
  source: AlarmLogSource;
  stationName: string;
  kind?: AlarmLogKind;
  phaseId?: AlarmPhaseId;
  reason: Extract<AlarmLogReason, `movement-${string}`>;
}): void {
  if (isBurstDuplicate(input.reason, input.stationName)) return;
  appendAlarmLog({
    ts: Date.now(),
    source: input.source,
    outcome: 'suppressed',
    reason: input.reason,
    stationName: input.stationName,
    kind: input.kind,
    phaseId: input.phaseId,
  });
}

/**
 * #746 — dismiss silence 게이트가 차단한 알람 1건 적재.
 * source는 호출 path를 식별: FG polling은 'fg', BG location task는 'bg',
 * silent push BG handler는 'silent-push-skipped'.
 */
export function logSuppressedDismissSilence(input: {
  source: AlarmLogSource;
  stationName: string;
  kind: AlarmLogKind;
  phaseId?: AlarmPhaseId;
}): void {
  appendAlarmLog({
    ts: Date.now(),
    source: input.source,
    outcome: 'suppressed',
    reason: 'dismiss-silence',
    stationName: input.stationName,
    kind: input.kind,
    phaseId: input.phaseId,
  });
}

/**
 * 취침모드 첫 환승 알람 누수 차단 1건 적재 (#750).
 * source는 호출 path를 식별: scheduler 사전예약은 'bg-scheduled', FG polling은 'fg',
 * BG silent push 등은 'bg' / 'silent-push-skipped' 중 호출자가 결정.
 * 알람 유형은 항상 transfer이므로 kind 고정 — 호출자가 다시 채울 필요 없음.
 */
export function logSuppressedSleepFirstTransfer(input: {
  source: AlarmLogSource;
  stationName: string;
  phaseId?: AlarmPhaseId;
}): void {
  appendAlarmLog({
    ts: Date.now(),
    source: input.source,
    outcome: 'suppressed',
    reason: 'sleep-first-transfer',
    stationName: input.stationName,
    kind: 'transfer',
    phaseId: input.phaseId,
  });
}

/**
 * #1236 (Epic #1204 D8 wire) — sleep 룰 게이트가 station-passed 카테고리에서 차단한 발사 1건 적재.
 * D8(#1227)에서 shouldSuppressBySleepRule이 'station-passed'도 차단하도록 확장됐고,
 * 본 PR이 dispatch path(FG GPS/arvlCd, BG)에서 동 게이트를 호출하도록 wire.
 * 2026-06-12 22:11:56 사가정 회귀 차단 evidence와 1:1 매핑.
 */
export function logSuppressedSleepStationPassed(input: {
  source: AlarmLogSource;
  stationName: string;
}): void {
  appendAlarmLog({
    ts: Date.now(),
    source: input.source,
    outcome: 'suppressed',
    reason: 'sleep-first-station-passed',
    stationName: input.stationName,
    kind: 'station-passed',
  });
}

/**
 * #1010 — station-passed effect가 lock hydrate 직후 30s warmup window 동안 차단된 발사 1건 적재.
 * stationName은 nearestStation?.name — unknown이면 undefined.
 */
/**
 * #1208 (Epic #1204 D2) — station-passed가 trip 진행도 hop window 밖이라 차단된 발사 1건 적재.
 * candidateIndex/currentHopIndex가 모두 알려진 경우 phaseId 슬롯에 ":hop=cur/cand" 문자열로 노출.
 * source는 호출 path 식별: FG polling은 'fg', BG는 'bg' 등.
 */
export function logSuppressedHopWindow(input: {
  source: AlarmLogSource;
  stationName: string;
  currentHopIndex: number;
  candidateIndex: number;
}): void {
  appendAlarmLog({
    ts: Date.now(),
    source: input.source,
    outcome: 'suppressed',
    reason: 'gate-hop-window',
    stationName: input.stationName,
    kind: 'station-passed',
    currentHopIndex: input.currentHopIndex,
    candidateIndex: input.candidateIndex,
  });
}

/**
 * #1208 (Epic #1204 D2) — hop window SSOT 부재로 게이트 미적용 1건 적재.
 * estimator/lock/firedAlarms 셋 다 hop index를 결정하지 못한 graceful skip을 측정.
 */
export function logSuppressedHopWindowNoSource(input: {
  source: AlarmLogSource;
  stationName: string;
}): void {
  appendAlarmLog({
    ts: Date.now(),
    source: input.source,
    outcome: 'suppressed',
    reason: 'gate-hop-window-no-source',
    stationName: input.stationName,
    kind: 'station-passed',
  });
}

/**
 * #1514 — lockless trip의 origin hop(arc[0] + currentHopIndex=0) station-passed 1건 차단 적재.
 *
 * `gate-hop-window`는 currentHopIndex ± windowSize 안의 candidate를 허용하므로 hopIndex=0일 때
 * arc[0] (출발역 자기 자신)이 통과한다. lockless trip은 사용자가 origin에 도달한 신호가 아니라
 * estimator default-hop이라 false positive — 본 reason으로 별도 분리해 운영에서 발생률을 추적한다.
 *
 * 호출자는 lock=null일 때만 본 함수를 호출 — lock 활성 trip은 boardingStationId 기준 origin
 * 알림이 정당 신호이므로 본 가드 미적용 (ADR-014 §4 사용자 명시 의향 동급 보장).
 */
export function logSuppressedOriginHopLockless(input: {
  source: AlarmLogSource;
  stationName: string;
}): void {
  appendAlarmLog({
    ts: Date.now(),
    source: input.source,
    outcome: 'suppressed',
    reason: 'gate-origin-hop-lockless',
    stationName: input.stationName,
    kind: 'station-passed',
  });
}

export function logSuppressedStationPassedWarmup(stationName: string | undefined): void {
  appendAlarmLog({
    ts: Date.now(),
    source: 'fg',
    outcome: 'suppressed',
    reason: 'gate-station-passed-warmup',
    stationName,
    kind: 'station-passed',
  });
}

/**
 * #1012 (H5) — useStationAlarm hydration state machine transition 1건 적재.
 *
 * pre-hydrate → hydrating → storage-synced → ready 4단계 중 진입 직후 호출.
 * destinationId는 같은 trip 내 transition 묶음을 그루핑하기 위한 컨텍스트.
 * source는 'fg-hydrate' 재사용 — 기존 hydrate 측정과 동일 소스에서 phase별 reason으로 구분.
 *
 * outcome='received'는 정책적으로 "관찰 신호" 의미 (적재만 하고 발사·억제 없음).
 */
export type HydrationPhase = 'pre-hydrate' | 'hydrating' | 'storage-synced' | 'ready';

const HYDRATION_PHASE_REASON: Record<HydrationPhase, AlarmLogReason> = {
  'pre-hydrate': 'hydration-pre-hydrate',
  hydrating: 'hydration-hydrating',
  'storage-synced': 'hydration-storage-synced',
  ready: 'hydration-ready',
};

export function logHydrationTransition(
  phase: HydrationPhase,
  destinationId: string | null,
): void {
  appendAlarmLog({
    ts: Date.now(),
    source: 'fg-hydrate',
    outcome: 'received',
    reason: HYDRATION_PHASE_REASON[phase],
    destinationId,
  });
}

/**
 * #918 A3 PR2 (#729 흡수) — `tba:` 사전 예약 알람의 fire-time 재검증 실패 1건 적재.
 *
 * scheduledAlarmReceiver가 OS-fired identifier를 reconcile하기 직전에 호출 — 적재 후 fired set /
 * lastStationName 갱신을 skip해 stale 알람이 후속 상태(BG arrival 기준역 등)를 오염시키지 않게 한다.
 * source='bg-scheduled' 재사용 — preschedule path 출처 통일(stamp/fired log와 동일 source).
 */
export function logSuppressedTbaRevalidation(input: {
  reason: 'revalidate-no-trip' | 'revalidate-route-sig-mismatch' | 'revalidate-waypoint-mismatch';
  stationName: string;
  phaseId?: AlarmPhaseId;
}): void {
  appendAlarmLog({
    ts: Date.now(),
    source: 'bg-scheduled',
    outcome: 'suppressed',
    reason: input.reason,
    stationName: input.stationName,
    phaseId: input.phaseId,
  });
}

/**
 * #1357 (S1) — preschedule 시점 motion gate가 사전예약을 skip한 1건 적재.
 *
 * `prescheduleStationAlerts` / `scheduleHopsForLock` 진입 직후 motion=stationary 확정 시 호출.
 * source는 'bg-scheduled'로 통일(다른 preschedule path log와 동일 source).
 * channel은 stationName 슬롯에 'tba'|'bl'로 인코딩해 두 path 분포를 같은 reason 카운터에서 구분 가능.
 */
export function logScheduleSkipped(input: {
  channel: 'tba' | 'bl';
  reason: 'motion-stationary';
  destinationName?: string;
}): void {
  // channel + destinationName을 stationName 슬롯에 인코딩 — 새 컬럼 추가 없이 share dump 가시화.
  // destinationName 미상이면 channel만 기록.
  const stationName = input.destinationName
    ? `${input.channel}:${input.destinationName}`
    : input.channel;
  appendAlarmLog({
    ts: Date.now(),
    source: 'bg-scheduled',
    outcome: 'suppressed',
    reason: 'schedule-skipped-motion-stationary',
    stationName,
  });
}

/** #1021: boardingPrompt 발사 1건 적재. */
export function logBoardingPromptFired(input: { originStation: string; line: string }): void {
  appendAlarmLog({
    ts: Date.now(),
    source: 'boarding-prompt',
    outcome: 'fired',
    stationName: `${input.line}·${input.originStation}`,
  });
}

/** #1021: 시간 윈도우별 boardingPrompt 발사 횟수. 5m / 1h / all. */
export const BOARDING_PROMPT_WINDOWS = [
  { key: '5m', label: '5m', ms: 5 * 60 * 1000 },
  { key: '1h', label: '1h', ms: 60 * 60 * 1000 },
  { key: 'all', label: 'all', ms: Infinity },
] as const;

export type BoardingPromptWindowKey = (typeof BOARDING_PROMPT_WINDOWS)[number]['key'];

export function countBoardingPromptByWindow(
  entries: readonly AlarmLogEntry[],
  now: number = Date.now(),
): Record<BoardingPromptWindowKey, number> {
  const counts: Record<BoardingPromptWindowKey, number> = { '5m': 0, '1h': 0, all: 0 };
  for (const entry of entries) {
    // #1170 — fired 중에서도 reason이 없는 entry만 "발사 빈도"로 계산. response/autolock telemetry
    // entry는 별도 채널이므로 제외(중복 집계 방지).
    if (entry.source !== 'boarding-prompt' || entry.outcome !== 'fired') continue;
    // #1167 — autolock outcome도 source='boarding-prompt'를 재사용하지만 outcome='suppressed'
    // 또는 reason='autolock-success'로 구분. 발사 빈도(#1021) 집계에는 reason 미설정 entry만 포함.
    // #1170 — response telemetry entry도 reason 필드를 채워 같은 규칙으로 제외된다.
    if (entry.reason !== undefined) continue;
    const ageMs = now - entry.ts;
    for (const { key, ms } of BOARDING_PROMPT_WINDOWS) {
      if (ageMs <= ms) counts[key] += 1;
    }
  }
  return counts;
}

/**
 * #1167 — boardingPrompt autoLock outcome 적재.
 *
 * 성공 시 outcome='fired' + reason='autolock-success', skip 시 outcome='suppressed' + skip 이유.
 * source='boarding-prompt'를 재사용해 한 화면에서 발사 빈도(#1021) + autolock 분포를 같이 본다.
 */
export type BoardingPromptAutoLockReason =
  | 'autolock-success'
  | 'autolock-no-trip'
  | 'autolock-arrivals-empty'
  | 'autolock-ambiguity'
  | 'autolock-station-lookup'
  | 'autolock-lock-failed';

export function logBoardingPromptAutoLock(input: {
  reason: BoardingPromptAutoLockReason;
  originStation: string;
  line: string;
}): void {
  appendAlarmLog({
    ts: Date.now(),
    source: 'boarding-prompt',
    outcome: input.reason === 'autolock-success' ? 'fired' : 'suppressed',
    reason: input.reason,
    stationName: `${input.line}·${input.originStation}`,
  });
}

/** #1167 — 최근 N건의 autolock outcome 분포 (운영 측정용). */
export function countBoardingPromptAutoLockOutcomes(
  entries: readonly AlarmLogEntry[],
): Record<BoardingPromptAutoLockReason, number> {
  const counts: Record<BoardingPromptAutoLockReason, number> = {
    'autolock-success': 0,
    'autolock-no-trip': 0,
    'autolock-arrivals-empty': 0,
    'autolock-ambiguity': 0,
    'autolock-station-lookup': 0,
    'autolock-lock-failed': 0,
  };
  for (const entry of entries) {
    if (entry.source !== 'boarding-prompt') continue;
    const reason = entry.reason;
    if (reason === undefined) continue;
    if (reason in counts) counts[reason as BoardingPromptAutoLockReason] += 1;
  }
  return counts;
}

/** #1170: boardingPrompt 사용자 응답 1건 적재. */
export function logBoardingPromptResponded(input: {
  outcome: 'boarded' | 'dismissed';
}): void {
  appendAlarmLog({
    ts: Date.now(),
    source: 'boarding-prompt',
    outcome: 'received',
    reason: input.outcome === 'boarded' ? 'response-boarded' : 'response-dismissed',
  });
}



// ── CRUD ──

// 모듈 스코프 mutable state (#735 batched write).
// 단일 프로세스 단일 인스턴스 가정 — React Native 앱 1 process.
//
// 동시성: JS는 single-thread지만 *await 사이*에 다른 microtask가 끼어든다 → RMW race 가능.
// flushInFlight Promise mutex로 두 개 이상의 flush가 동시에 getItem/setItem 사이클을 돌지 않도록
// 직렬화한다. 단순 single-thread 가정만으론 lost-update가 발생한다 (review #1 발견).
let pendingEntries: AlarmLogEntry[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let oldestPendingTs: number | null = null;
let flushInFlight: Promise<void> | null = null;

/**
 * 알람 로그 1건 적재 (#735 — 동기 in-memory push).
 *
 * 기존 RMW 동작에서 변경: 즉시 storage write 안 함. 메모리 pending에 push하고 debounce/max-delay
 * 정책에 따라 일괄 flush. UI(DebugModal)는 getAlarmLog()가 pending 병합해 반환하므로 즉시 가시.
 *
 * 호출자는 await 불필요 (void). 손실 cap을 더 줄여야 하는 critical 경로(silent push BG task 종료
 * 직전 등)에서는 await flushAlarmLog() 명시 호출.
 */
export function appendAlarmLog(entry: AlarmLogEntry): void {
  // #1024 — burst inline counter: reason이 있는 억제 엔트리에서 마지막 pendingEntry가
  // 동일한 (source, reason, kind, phaseId, stationName)이면 count++하고 ts를 갱신한다.
  if (entry.reason !== undefined && pendingEntries.length > 0) {
    const last = pendingEntries[pendingEntries.length - 1];
    if (
      last.reason === entry.reason &&
      last.source === entry.source &&
      last.kind === entry.kind &&
      last.phaseId === entry.phaseId &&
      last.stationName === entry.stationName
    ) {
      last.count = (last.count ?? 1) + 1;
      last.ts = entry.ts;
      scheduleFlush();
      return;
    }
  }
  pendingEntries.push(entry);
  oldestPendingTs ??= Date.now();
  scheduleFlush();
}

function fireAndForgetFlush(): void {
  // flushAlarmLog는 doFlushOnce 내부 try/catch로 모든 storage 에러를 swallow하므로 reject 안 함.
  // 따라서 별도 .catch가 dead branch라 생략 — Promise floating은 의도된 fire-and-forget.
  flushAlarmLog();
}

function scheduleFlush(): void {
  // 가장 오래된 pending이 MAX_DELAY 도달했으면 즉시 flush.
  // 기존 flushTimer는 doFlushOnce에서 클리어 — 본 위치에서 중복 클리어 불필요.
  if (oldestPendingTs != null && Date.now() - oldestPendingTs >= FLUSH_MAX_DELAY_MS) {
    fireAndForgetFlush();
    return;
  }
  if (flushTimer != null) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    fireAndForgetFlush();
  }, FLUSH_DEBOUNCE_MS);
}

/**
 * 메모리 pending을 storage에 1회 RMW로 일괄 적재 (#735).
 *
 * 호출 시점:
 *   1) scheduleFlush의 debounce timer 만료
 *   2) MAX_DELAY 즉시 flush
 *   3) AppState 'background'/'inactive' 진입 (모듈 스코프 listener)
 *   4) silentPushTask 종료 직전 명시 호출 (BG task 시간 만료 직전 손실 방지)
 *   5) 테스트
 *
 * 동시성 안전 (review P1 fix):
 *   - 첫 호출자만 doFlushOnce()를 실제 실행하고, 그 promise를 flushInFlight에 저장.
 *   - 중첩 호출자(다른 트리거가 동시에 flush 요청)는 같은 flushInFlight를 await한 뒤,
 *     자신이 추가한 pending이 남아있으면 재귀 호출로 다음 RMW 사이클을 보장.
 *   - JS single-thread는 동기 구간만 보호 — await 사이엔 다른 microtask가 끼어들어
 *     두 doFlushOnce가 같은 storage 상태를 보고 서로의 write를 덮는 lost-update가 발생.
 *     본 mutex 패턴이 RMW를 직렬화.
 */
export async function flushAlarmLog(): Promise<void> {
  if (flushInFlight) {
    await flushInFlight;
    // 직전 flush 중에 우리(다른 caller)가 추가한 entry가 남아있으면 다음 cycle로 적재 보장.
    if (pendingEntries.length > 0) await flushAlarmLog();
    return;
  }
  if (pendingEntries.length === 0) return;
  flushInFlight = doFlushOnce();
  try {
    await flushInFlight;
  } finally {
    flushInFlight = null;
  }
}

async function doFlushOnce(): Promise<void> {
  const toFlush = pendingEntries;
  pendingEntries = [];
  oldestPendingTs = null;
  if (flushTimer != null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  try {
    const raw = await AsyncStorage.getItem(ALARM_LOG_KEY);
    const existing: AlarmLogEntry[] = raw ? safeParse(raw) : [];
    const next = [...existing, ...toFlush];
    // FIFO: 가장 오래된 것부터 drop
    const trimmed = next.length > ALARM_LOG_BUFFER_SIZE
      ? next.slice(next.length - ALARM_LOG_BUFFER_SIZE)
      : next;
    await AsyncStorage.setItem(ALARM_LOG_KEY, JSON.stringify(trimmed));
  } catch (e) {
    logger.error('알람 로그 적재 실패:', e);
  }
}

export async function getAlarmLog(): Promise<AlarmLogEntry[]> {
  try {
    const raw = await AsyncStorage.getItem(ALARM_LOG_KEY);
    const persisted: AlarmLogEntry[] = raw ? safeParse(raw) : [];
    // #735 — pending 병합. UI는 최신 상태를 즉시 봐야 한다(flush 전 적재 entry 포함).
    // pending은 시간순으로 push되므로 persisted 뒤에 concat.
    if (pendingEntries.length === 0) return persisted;
    const merged = [...persisted, ...pendingEntries];
    return merged.length > ALARM_LOG_BUFFER_SIZE
      ? merged.slice(merged.length - ALARM_LOG_BUFFER_SIZE)
      : merged;
  } catch (e) {
    logger.error('알람 로그 읽기 실패:', e);
    // storage 실패해도 pending은 노출 — 진단 가시성 유지.
    return [...pendingEntries];
  }
}

export async function clearAlarmLog(): Promise<void> {
  // #735 — pending도 초기화. flush race로 storage 비운 후 pending이 다시 적재되지 않도록.
  pendingEntries = [];
  oldestPendingTs = null;
  if (flushTimer != null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  try {
    await AsyncStorage.removeItem(ALARM_LOG_KEY);
  } catch (e) {
    logger.error('알람 로그 삭제 실패:', e);
  }
}

/**
 * 테스트 전용 — 모듈 스코프 상태 초기화 (#735).
 * pendingEntries / flushTimer / oldestPendingTs를 reset해 테스트 간 격리.
 * production 호출 금지.
 */
export function resetAlarmLogForTest(): void {
  pendingEntries = [];
  oldestPendingTs = null;
  if (flushTimer != null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  flushInFlight = null;
}

function safeParse(raw: string): AlarmLogEntry[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      logger.error('알람 로그 형태 손상(비배열) — 빈 로그로 초기화');
      return [];
    }
    return parsed;
  } catch {
    logger.error('알람 로그 JSON 손상 — 빈 로그로 초기화');
    return [];
  }
}

// #735 — AppState 'background'/'inactive' 진입 시 자동 flush. OS suspend 전 pending 손실 방지.
// 모듈 로드 시 1회 등록 (singleton). subscription.remove는 production에서 불필요 (앱 lifetime 동일).
function handleAppStateChange(state: AppStateStatus): void {
  if (state === 'background' || state === 'inactive') {
    fireAndForgetFlush();
  }
}
AppState.addEventListener('change', handleAppStateChange);

/**
 * 테스트 전용 — AppState 전환 시뮬레이트 (#735).
 * 모듈 스코프 listener 등록은 jest.mock 호이스팅과 race 발생하기 쉬워, 캡처된 listener를
 * 외부에서 호출하기 어렵다. 테스트는 본 helper로 handleAppStateChange를 직접 트리거.
 * production 호출 금지.
 */
export function _simulateAppStateForTest(state: AppStateStatus): void {
  handleAppStateChange(state);
}

/**
 * 알람 로그 항목에서 지정된 reason 목록에 해당하는 항목만 집계 (#1025).
 * DebugModal Gates 섹션에서 gate/movement reason별 분포를 시각화하는 데 사용.
 * 결과: `reason → count` (count > 0인 항목만). 빈 객체이면 관련 항목 없음.
 */
export function countGateReasons(
  logs: readonly AlarmLogEntry[],
  reasons: readonly AlarmLogReason[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  const reasonSet = new Set<string>(reasons);
  for (const entry of logs) {
    if (entry.reason && reasonSet.has(entry.reason)) {
      counts[entry.reason] = (counts[entry.reason] ?? 0) + 1;
    }
  }
  return counts;
}
