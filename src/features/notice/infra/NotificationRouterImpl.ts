/**
 * #1575 (T12, ADR-017) — NotificationRouter 기본 구현.
 *
 * 4 gate 통과 후 surface로 fan-out:
 *   1. dedup-same-surface: `(alarmId, surface)` 이미 deliver → suppress.
 *   2. gate-alarm-not-in-ssot: backend mirror fresh + alarmId 부재 → reject (mirror stale 시 자동 pass).
 *   3. gate-station-already-passed: SSoT.passedStations에 stationId 포함 → reject.
 *   4. gate-sleep-mode-blocked: sleepMode ON + sleepRuleEligible → reject.
 *
 * 통과 시 surface별 side-effect 함수(`surfaces.banner` 등)를 호출. surface 함수가 throw해도
 * delivery log에는 'delivered' 로 기록 (호출 시도 자체는 발생). 후속 PR에서 surface별 try/catch
 * + 'failed' result type 추가 예정.
 *
 * factory 패턴인 이유:
 *   - notice 슬라이스가 alarm/widget을 직접 import하면 ESLint `import/no-restricted-paths` 위반.
 *   - 호출자(상위 orchestrator, 보통 hook 또는 task)가 surface 함수를 inject하면 분리 유지 + mock 용이.
 */

import type {
  DeliveryRequest,
  DeliveryResult,
  NotificationRouter,
} from '../ports/NotificationRouter';
import {
  appendDeliveryEntry,
  clearDeliveryLog,
} from '../store/notificationDeliveryLog';

/**
 * backend SSoT mirror가 stale로 간주되는 임계. 5분 이상 mirror 갱신 없으면 validation 자동 pass.
 *
 * silent push가 cron 30s 주기로 도착하므로 5분 = 약 10 cycle. 그 이상 끊겼다면 backend connectivity
 * 자체 문제로 보고 device-side gate에 의존. 보수적 임계 — false reject 회피 우선.
 */
export const SSOT_MIRROR_STALE_MS = 5 * 60 * 1000;

/**
 * backend SSoT mirror snapshot — router가 검증에 사용하는 최소 형태.
 * 호출자(orchestrator)가 readBackendSsotMirror 등으로 읽어 inject. null이면 mirror 없음 → 검증 자동 pass.
 */
export interface RouterSsotMirror {
  passedStations: readonly string[];
  receivedAt: number;
}

export interface RouterSurfaceFns {
  /** banner 발사 (보통 expo-notifications scheduleNotificationAsync wrap). */
  banner: (req: DeliveryRequest) => Promise<void> | void;
  /** Live Activity 갱신 (modules/live-activity updateLiveActivity wrap). */
  liveActivity: (req: DeliveryRequest) => Promise<void> | void;
  /** widget storage 갱신 (features/widget saveStationToWidget wrap). */
  widget: (req: DeliveryRequest) => Promise<void> | void;
  /** in-app banner store 갱신 (useAlarmEventStore.setAlarmEvent wrap). */
  inApp: (req: DeliveryRequest) => Promise<void> | void;
  /**
   * trip 종료 시 surface별 cleanup. fire-and-forget. router.clearAllForTrip에서 호출.
   * 옵션 — 미제공 시 cleanup은 dedup map 클리어만 수행.
   */
  clearAll?: () => Promise<void> | void;
}

export interface RouterDeps {
  surfaces: RouterSurfaceFns;
  /**
   * backend SSoT mirror 조회 함수 — orchestrator가 alarm/utils/backendSsotMirror.readBackendSsotMirror
   * 등을 inject. null 반환 시 검증 skip (mirror 없음).
   *
   * 본 파라미터를 inject 받는 이유: notice 슬라이스가 alarm 슬라이스를 직접 import하면 ESLint
   * `import/no-restricted-paths` 위반. 호출자(상위 orchestrator)가 cross-feature 책임을 진다.
   */
  readSsotMirror: () => Promise<RouterSsotMirror | null>;
}

/**
 * router 인스턴스 factory.
 *
 * caller는 앱 부팅 시 1회 호출해 deps를 inject. 반환된 instance를 module-level singleton으로
 * 보관해 fire path 어디서든 동일 dedup map을 공유한다.
 */
export function createNotificationRouter(
  deps: RouterDeps,
): NotificationRouter {
  const { surfaces, readSsotMirror } = deps;
  // dedup key: `${alarmId}:${surface}`. Set으로 충분 — TTL은 trip 단위 (clearAllForTrip에서 reset).
  // 같은 (alarmId, surface) 2회째 deliver 시도가 첫 deliver의 race로 들어와도 sync .has 체크 + add로
  // 직렬화돼 두 번째는 dedup-same-surface로 suppress. Promise.all fan-out에서도 안전.
  const dedupKeys = new Set<string>();

  return {
    deliver: (req) => deliverInternal(req, surfaces, dedupKeys, readSsotMirror),
    clearAllForTrip: async () => {
      dedupKeys.clear();
      await clearDeliveryLog();
      if (surfaces.clearAll) {
        try {
          await surfaces.clearAll();
        } catch {
          // graceful — clearAll 실패해도 dedup map + delivery log는 이미 클리어됨.
        }
      }
    },
  };
}

async function deliverInternal(
  req: DeliveryRequest,
  surfaces: RouterSurfaceFns,
  dedupKeys: Set<string>,
  readSsotMirror: () => Promise<RouterSsotMirror | null>,
): Promise<DeliveryResult> {
  const now = Date.now();
  const dedupKey = `${req.alarmId}:${req.surface}`;

  // 1. dedup-same-surface — 동일 (alarmId, surface) 이미 deliver됨.
  if (dedupKeys.has(dedupKey)) {
    return logAndReturn(req, false, 'dedup-same-surface', now);
  }

  // 2/3. backend SSoT mirror gate. mirror stale(>5분) → 자동 pass (보수적).
  const mirror = await readSsotMirror();
  if (mirror !== null && now - mirror.receivedAt < SSOT_MIRROR_STALE_MS) {
    // mirror가 alarmEvents를 보유하지 않는 (T8 이전 backend) 시점이라면 검증 skip.
    // 현재 BackendSsotMirrorEntry는 alarmEvents 필드 없음 — T12 wire-up 후 도입 예정.
    // 본 PR은 passedStations gate만 적용. alarmEvents gate는 후속 PR에서 mirror schema 확장 후 wire.
    const stationId = req.content.data?.stationId;
    if (
      typeof stationId === 'string' &&
      mirror.passedStations.includes(stationId)
    ) {
      return logAndReturn(req, false, 'gate-station-already-passed', now);
    }
  }

  // 4. sleep mode gate. sleepRuleEligible true 일 때만 적용 — destination은 항상 fire.
  if (req.sleepMode === true && req.sleepRuleEligible === true) {
    return logAndReturn(req, false, 'gate-sleep-mode-blocked', now);
  }

  // pass — dedup 등록 후 surface fan-out.
  dedupKeys.add(dedupKey);
  await dispatchToSurface(req, surfaces);

  appendDeliveryEntry({
    alarmId: req.alarmId,
    eventKey: req.eventKey,
    surface: req.surface,
    source: req.source,
    result: 'delivered',
    at: now,
  });
  return { delivered: true, surface: req.surface, deliveredAt: now };
}

async function dispatchToSurface(
  req: DeliveryRequest,
  surfaces: RouterSurfaceFns,
): Promise<void> {
  const fn =
    req.surface === 'banner'
      ? surfaces.banner
      : req.surface === 'live-activity'
        ? surfaces.liveActivity
        : req.surface === 'widget'
          ? surfaces.widget
          : surfaces.inApp;
  try {
    await fn(req);
  } catch {
    // graceful — 한 surface 실패가 다른 surface fan-out을 막지 않도록 swallow.
    // 후속 PR에서 'failed' result type + 재시도 큐 도입 예정.
  }
}

/**
 * gate에서 차단된 요청을 delivery log에 'suppressed'로 기록하고 결과 반환.
 * delivered=true 경로는 dispatchToSurface 통과 후 직접 appendDeliveryEntry — 본 함수 미사용.
 */
function logAndReturn(
  req: DeliveryRequest,
  delivered: false,
  reason: DeliveryResult['reason'],
  at: number,
): DeliveryResult {
  appendDeliveryEntry({
    alarmId: req.alarmId,
    eventKey: req.eventKey,
    surface: req.surface,
    source: req.source,
    result: 'suppressed',
    reason,
    at,
  });
  return { delivered, reason, surface: req.surface, deliveredAt: at };
}
