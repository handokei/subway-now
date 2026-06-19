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
 */
export function markStationFired(
  destinationId: string,
  stationName: string,
  category: FireCategory,
  now: number,
): void {
  lastFire.set(makeKey(destinationId, stationName), { ts: now, category });
  sweepExpired(now);
}

/** 테스트 전용 — 모듈 상태 리셋. production 호출 금지. */
export function _resetCrossCategoryDedupForTests(): void {
  lastFire.clear();
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
  return Promise.resolve();
}
