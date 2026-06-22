/**
 * #1515 — Cross-category station-level dedup.
 *
 * 문제(2026-06-19 trip): 같은 destinationId·같은 station에서 카테고리가 다르면 dedup이 분리돼
 * 14초 안에 3건의 알람이 발사되는 회귀.
 *   08:37:08 destination(early)  성수  ← firedAlarms set 키 = `early:성수`
 *   08:37:19 station-passed       성수  ← lastNotifiedStationId 단일 출처
 *   08:37:22 station-passed       성수  ← #19 fire의 await sendNotification 중 race
 *
 * 기존 dedup:
 *   - destination/transfer phase: `firedAlarmsRef` (key=`${phaseId}:${stationName}`)
 *   - station-passed: `lastNotifiedStationId` (destinationId 단위 단일 값)
 *   - 두 출처가 분리돼 cross-category가 서로를 silence하지 못함.
 *
 * 본 util은 두 출처 위에 얹는 **station-level** 통합 dedup이다.
 * 키: `${destinationId}|${normalizedStationName}`. 단일 in-memory Map.
 * 윈도우: WINDOW_MS(기본 30s) — 사용자 인지 "계속 울린다" 회귀 차단 시간.
 *
 * 우선순위/정책:
 *   - destination > station-passed. destination/transfer가 먼저 fire되면 station-passed suppress.
 *   - 같은 station에 station-passed가 먼저 fire되면 후속 destination도 suppress(이미 알람 1건 발사됨).
 *   - 환승역 line 분기 fire(같은 stationName, 다른 stationId)는 stationName이 같으면 동일 키에 묶임.
 *     같은 물리적 역이라 OK(트립 진행 중 자연스럽게 한 번만 fire). 이슈 acceptance: "환승역 line별
 *     분리 fire 보존" — destination이 환승역이 아닌 한 영향 X. 환승역 자체에서의 추가 fire는
 *     "동일 station 30s 내 1건"이라는 본 acceptance 정책과 정합.
 *
 * 호출 시점:
 *   1. fire 직전 — `isStationRecentlyFired(destId, stationName, now)`로 차단 여부 결정.
 *   2. fire 성공 직후 — `markStationFired(destId, stationName, now)`로 윈도우 갱신.
 *
 * 비휘발성: in-memory map만 사용. 앱 재시작 시 reset되며 그 직후엔 hydration warmup으로 차단된다.
 * 따라서 storage write가 필요 없다(저장 race가 본 회귀의 직접 원인이라 의도적으로 회피).
 */

/**
 * 역명 정규화: 괄호 안 부속 표기 제거 + trim. stationRoute의 normalizeStationName과 동등.
 * 별도 함수로 둔 이유: stationRoute는 cross-feature orchestrator/테스트에서 광범위하게 mock되며
 * normalizeStationName이 mock 누락되면 본 util이 런타임 throw → BG path 발사 자체가 깨진다.
 * 본 dedup은 매우 작은 가벼운 normalize로 충분 — 외부 의존 0.
 */
function normalizeStationName(name: string): string {
  // 입력은 stations.json BLDN_NM(짧은 역명 + 선택적 단일 괄호)으로 제한된 도메인. ReDoS 위험 없음. NOSONAR
  return name.replace(/\([^)]*\)/g, '').trim(); // NOSONAR typescript:S5852
}

/** 같은 station에 대해 cross-category fire를 차단하는 윈도우. */
export const CROSS_CATEGORY_DEDUP_WINDOW_MS = 30_000;

/**
 * #1643 — trip-scoped 즉시 cascade 윈도우.
 * 같은 trip(destinationId) 안에서 **다른 station + cross-category(phase↔SP)** 알람이 같은 cycle/
 * 즉시 cascade로 발사되는 회귀(2026-06-20 12:31 어대 "군자 도착"(SP)+"곧 성수 도착"(D imminent))를 차단한다.
 * 짧은 윈도우(5s)로 잡아 정상 진행(30s cycle)에 영향이 없도록 한다.
 * ADR-010 첫 줄 (false positive ↔ miss 동급) 정합 — window를 좁게 두어 miss 위험 최소화.
 * 같은 그룹(phase↔phase, SP→SP) cross-station은 통과시킴 — 정상 trip 진행 보존.
 */
export const TRIP_SCOPED_CROSS_CATEGORY_WINDOW_MS = 5_000;

/**
 * #1656 — phase↔phase cross-station 즉시 cascade 윈도우.
 *
 * 같은 trip(destinationId) 안에서 **다른 station + 양쪽 phase 카테고리(transfer/destination)**가 같은
 * cycle/leg 전환 race로 연이어 발사되는 회귀를 차단한다:
 *   - 2026-06-20 12:32 어대 "곧 건대 도착"(transfer imminent, line 7) + "성수 도착"(destination, line 2)
 *   - 2026-06-19 15:37 BG "곧 이수 도착"(destination imminent, line 4) + "다음 역 사당 하차"(transfer, line 4→2)
 *
 * `TRIP_SCOPED_CROSS_CATEGORY_WINDOW_MS`(5s, SP↔phase) 보다 좁은 3s 윈도우 — phase→phase 정상 leg 진행
 * (환승 직후 새 leg의 early phase 즉시 fire 등)을 보존하기 위해 더 좁게 잡는다. 같은 cycle 즉시 cascade
 * (< 1s)만 차단하면 충분.
 *
 * ADR-010 첫 줄(false positive ↔ miss 동급) 정합 — window를 좁게 두어 miss 위험 최소화.
 */
export const PHASE_TO_PHASE_CROSS_STATION_WINDOW_MS = 3_000;

/** Map 무한 성장 cap. 정상 trip(역 수 ~수십) × destination ~수 = ≤ 수백. cap 도달 시 만료 일괄 정리. */
const DEDUP_MAP_CAP = 256;

/**
 * fire category. AlarmLogKind와 의미적으로 동일하지만 본 dedup 의도(cross-category) 명시 위해
 * 별도 type alias. station-passed vs phase(destination/transfer) 2개 그룹으로 차단 판정.
 */
export type FireCategory = 'destination' | 'transfer' | 'station-passed';

interface FireRecord {
  ts: number;
  category: FireCategory;
}

const lastFire = new Map<string, FireRecord>();

/**
 * #1643 — trip-scoped last-fire 추적. 키는 destinationId만.
 *
 * 사용자 trip evidence (2026-06-20 12:31 어대) 회귀는 같은 trip 안에 **다른 stationName + cross-category
 * (SP↔phase)** 알람이 5s 안에 연이어 발사되는 형태:
 *   - "군자 도착"(station-passed) → "곧 성수 도착"(destination imminent)
 *
 * 같은 그룹 cross-station (예: phase→phase, SP→SP) 또는 같은 station 진행(early→imminent)은
 * 정상 동작이므로 통과시킴 — 본 record는 두 비교를 위해 stationName과 category를 모두 보존한다.
 *
 * phase→phase cross-station 회귀(2026-06-20 12:32 어대 "곧 건대"+"성수 도착", 2026-06-19 15:37 BG
 * "곧 이수"+"다음 역 사당")는 본 PR 범위 외 — `evaluateAlarmPhase`의 currentLine 게이트가 담당하며,
 * 별도 followup 이슈로 분리해 추적.
 *
 * 정상 30s cycle 진행(다음 hop fire)은 5s 윈도우 통과 → 정상 발사 보장.
 */
interface TripFireRecord {
  ts: number;
  category: FireCategory;
  stationName: string;
}
const lastTripFire = new Map<string, TripFireRecord>();

function makeKey(destinationId: string, stationName: string): string {
  return `${destinationId}|${normalizeStationName(stationName)}`;
}

function sweepExpired(now: number): void {
  if (lastFire.size <= DEDUP_MAP_CAP) return;
  for (const [k, rec] of lastFire) {
    if (now - rec.ts >= CROSS_CATEGORY_DEDUP_WINDOW_MS) lastFire.delete(k);
  }
}

/**
 * 두 fire category가 본 dedup의 차단 대상인지 판정.
 *
 * 차단 정책:
 *   - station-passed ↔ destination/transfer: 차단 (cross-category 본 회귀, 2026-06-19 성수).
 *   - station-passed → station-passed: 차단. lastNotifiedStationId가 AsyncStorage 라운드트립
 *     race에 취약해 FG GPS path와 fast-path(fg-arvlcd) 두 effect가 같은 사이클에 둘 다 발사하는
 *     사례 존재(2026-06-19 08:37:19→22 성수 3초 간격 재발사). station 단위 인메모리 reservation으로 race 차단.
 *   - destination ↔ destination/transfer: 차단 X (early→imminent 같은 정상 phase 진행 보존).
 *     이 그룹은 firedAlarms set이 phaseId 단위로 dedup.
 *
 * 요약: 한 쪽이라도 station-passed면 차단, 양쪽 모두 phase(destination|transfer)면 허용.
 */
function isCrossCategory(prev: FireCategory, current: FireCategory): boolean {
  return prev === 'station-passed' || current === 'station-passed';
}

/**
 * #1643 — 카테고리 그룹 차이 판정. `isCrossCategory`와 다름:
 *   - `isCrossCategory`: SP→SP도 true (per-station race 차단 의도, #1515).
 *   - `isCategoryGroupChange`: SP↔phase 그룹 변화일 때만 true (SP→SP / phase→phase = false).
 *
 * trip-scoped cascade 회귀(2026-06-20 어대 evidence)는 phase↔SP 그룹 cascade — 같은 그룹 안
 * cross-station은 정상 trip 진행이라 통과시켜야 한다.
 */
function isCategoryGroupChange(prev: FireCategory, current: FireCategory): boolean {
  const prevIsSP = prev === 'station-passed';
  const currentIsSP = current === 'station-passed';
  return prevIsSP !== currentIsSP;
}

/**
 * cross-category fire가 윈도우 내에 발생했는지 확인.
 * fire 직전 호출 — true면 호출자는 발사를 skip하고 `dedup-station-unified`로 로그.
 *
 * 같은 category(예: destination phase가 early→imminent로 진행)는 본 함수가 false를 반환해
 * 기존 firedAlarms(phase) / lastNotifiedStationId(station-passed) dedup이 단독으로 작동한다.
 */
export function isStationRecentlyFired(
  destinationId: string,
  stationName: string,
  category: FireCategory,
  now: number,
  windowMs: number = CROSS_CATEGORY_DEDUP_WINDOW_MS,
): boolean {
  const rec = lastFire.get(makeKey(destinationId, stationName));
  if (rec === undefined) return false;
  if (now - rec.ts >= windowMs) return false;
  return isCrossCategory(rec.category, category);
}

/**
 * fire 성공 직후 윈도우 갱신. 호출자는 알람 노출 직전/직후에 호출한다.
 * 같은 station에 후속 fire가 발생하면 category가 덮어쓰여 최근 fire를 기준으로 cross-cat 판정.
 *
 * #1643 — 같은 trip의 last fire도 함께 갱신(station 무관). trip-scoped cross-category cascade 차단용.
 */
export function markStationFired(
  destinationId: string,
  stationName: string,
  category: FireCategory,
  now: number,
): void {
  lastFire.set(makeKey(destinationId, stationName), { ts: now, category });
  lastTripFire.set(destinationId, {
    ts: now,
    category,
    stationName: normalizeStationName(stationName),
  });
  sweepExpired(now);
}

/**
 * #1643 — trip-scoped cross-category + cross-station 즉시 cascade가 짧은 윈도우 내에 발생했는지 확인.
 *
 * 같은 trip(destinationId)에 직전 fire가 본 query와:
 *   1) **다른 station** (stationName 비교, normalize 후)
 *   2) **cross-category** (한 쪽은 phase, 다른 쪽은 station-passed)
 * 두 조건을 모두 만족하면 차단.
 *
 * trip evidence 회귀(2026-06-20 12:31 어대 "군자 도착"(SP) + "곧 성수 도착"(D imminent))를 잡는다.
 *
 * 차단하지 않는 케이스 (정상 동작 보존):
 *   - **같은 station 진행** (early→imminent): per-station dedup(`isStationRecentlyFired`)이 담당.
 *   - **same-category cross-station**: station-passed→station-passed (정상 trip 폴링 station 변경),
 *     phase→phase (`isPhaseToPhaseCrossStationRecentlyFired`가 3s 윈도우로 별도 차단).
 *
 * 윈도우(5s, TRIP_SCOPED_CROSS_CATEGORY_WINDOW_MS)는 사용자 체감 cascade(< 1s)만 차단하고
 * 정상 진행(30s cycle 다음 hop fire)은 통과시키도록 좁게 설정.
 *
 * fire 직전 호출 — true면 호출자는 발사 skip + 'dedup-cross-category-recent' 로그.
 */
export function isTripScopedCrossCategoryRecentlyFired(
  destinationId: string,
  stationName: string,
  category: FireCategory,
  now: number,
  windowMs: number = TRIP_SCOPED_CROSS_CATEGORY_WINDOW_MS,
): boolean {
  const rec = lastTripFire.get(destinationId);
  if (rec === undefined) return false;
  if (now - rec.ts >= windowMs) return false;
  // 같은 station 진행(예: early→imminent)은 통과 — per-station dedup이 담당.
  if (rec.stationName === normalizeStationName(stationName)) return false;
  // 같은 그룹(phase↔phase or SP→SP) cross-station은 통과 — 정상 trip 진행 보존.
  return isCategoryGroupChange(rec.category, category);
}

/**
 * #1656 — phase↔phase cross-station 즉시 cascade가 짧은 윈도우 내에 발생했는지 확인.
 *
 * 같은 trip(destinationId)에 직전 fire가 본 query와:
 *   1) **다른 station** (stationName 비교, normalize 후)
 *   2) **양쪽 모두 phase** (destination 또는 transfer; station-passed 제외)
 * 두 조건을 모두 만족하면 차단.
 *
 * trip evidence 회귀:
 *   - 2026-06-20 12:32 어대: "곧 건대 도착"(transfer imminent) + "성수 도착"(destination)
 *     ← leg 전환 race에서 옛 leg(2호선→건대입구 imminent) + 새 leg(7호선→성수 도착) 동시 fire
 *   - 2026-06-19 15:37 BG: "곧 이수 도착"(destination imminent) + "다음 역 사당 하차"(transfer)
 *     ← 동일 race 패턴, BG path
 *
 * 차단하지 않는 케이스 (정상 동작 보존):
 *   - **같은 station 진행** (early→imminent on same station): per-station firedAlarms가 dedup.
 *   - **station-passed 포함**: `isTripScopedCrossCategoryRecentlyFired`(5s) 또는
 *     `isStationRecentlyFired`(30s)가 커버.
 *
 * 윈도우(3s, PHASE_TO_PHASE_CROSS_STATION_WINDOW_MS)는 SP↔phase 5s보다 좁음 — leg 전환 직후
 * 새 leg의 early phase가 즉시 fire돼야 정상인 케이스를 보존하기 위해 더 좁게 잡는다.
 *
 * fire 직전 호출 — true면 호출자는 발사 skip + 'dedup-phase-to-phase' 로그.
 */
export function isPhaseToPhaseCrossStationRecentlyFired(
  destinationId: string,
  stationName: string,
  category: FireCategory,
  now: number,
  windowMs: number = PHASE_TO_PHASE_CROSS_STATION_WINDOW_MS,
): boolean {
  // station-passed는 본 함수가 담당하는 phase↔phase 차단 대상이 아님.
  if (category === 'station-passed') return false;
  const rec = lastTripFire.get(destinationId);
  if (rec === undefined) return false;
  if (now - rec.ts >= windowMs) return false;
  // 직전 fire가 station-passed면 본 함수 대상 아님(isTripScopedCrossCategoryRecentlyFired 담당).
  if (rec.category === 'station-passed') return false;
  // 같은 station 진행(early→imminent on same station)은 통과 — firedAlarms set이 dedup.
  if (rec.stationName === normalizeStationName(stationName)) return false;
  // 여기까지 오면: 직전=phase, 현재=phase, 다른 station, 윈도우 안 → 차단.
  return true;
}

/** 테스트 전용 — 모듈 상태 리셋. production 호출 금지. */
export function _resetCrossCategoryDedupForTests(): void {
  lastFire.clear();
  lastTripFire.clear();
}

/**
 * #1545 (S12) — trip 종료 시 dedup 윈도우 전체 클리어.
 *
 * 사용자가 같은 destination으로 새 trip을 즉시 다시 시작할 때, 직전 trip에서 fire된 station
 * 키가 30s 윈도우 안에 살아 있으면 새 trip의 같은 station 첫 fire가 silence된다. 본 함수는
 * `TRIP_BOUND_CLEANUPS`에 wiring되어 BG silent push trip-ended 경로에서도 모든 fire 기록을
 * 비운다 (멱등 — 빈 Map에서도 graceful no-op).
 */
export function clearCrossCategoryDedup(): Promise<void> {
  lastFire.clear();
  lastTripFire.clear();
  return Promise.resolve();
}
