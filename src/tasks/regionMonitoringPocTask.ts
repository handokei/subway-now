import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { createLogger } from '../utils/logger';
import { logRegionEntryFired } from '../utils/alarmLog';

// #563 PoC — iOS Region Monitoring을 WhileInUse 권한 + BG 진입 wake 환경에서 실측 검증한다.
// PoC 임시 코드: 채널 3(Region Monitoring) 본구현 진입 전 신뢰도 측정용. 머지하지 않는다.
//
// 측정 항목 (issue #563):
//   1. WhileInUse + BG 상태 진입 wake 안정성
//   2. 지하 구간 감지율 (iOS WiFi BSSID DB 커버리지)
//   3. 환승 시 region 재등록 매끄러움
//   4. 저전력 모드 ON 상태 동작 여부
//
// 결과는 `tasks/region-monitoring-poc-result.md`에 누적.

const logger = createLogger('RegionPoc');

export const REGION_POC_TASK = 'region-monitoring-poc-task';

/**
 * PoC에서 모니터링할 region 1건. iOS는 region.identifier로 enter/exit를 식별하고
 * 콜백에 identifier만 넘긴다 — caller는 분석을 쉽게 하려면 identifier에 한국어 역명을
 * 그대로 넣는 것을 권장(예: '강남'). 역 id를 쓸 거면 PoC 분석 시 id↔이름 매핑이 별도 필요.
 */
export interface PocRegion {
  identifier: string;
  latitude: number;
  longitude: number;
  /** iOS 권장 최소 100m. 너무 작으면 지하 구간에서 거의 못 잡는다. */
  radius: number;
}

/** Task 콜백에 흘러들어오는 expo-location geofencing 이벤트 페이로드. */
interface PocEventData {
  eventType: Location.GeofencingEventType;
  region: {
    identifier?: string;
    latitude?: number;
    longitude?: number;
    radius?: number;
  };
}

/**
 * Region 진입/이탈 이벤트 핸들러.
 * Enter는 production source `region-entry-fired`로 적재(측정 인프라 #564 재사용).
 * Exit는 alarmLog에 적재할 source가 없어 logger.info로만 남긴다 — PoC 종료 후 console.app/Xcode에서 회수.
 */
async function handleRegionEvent({ data, error }: TaskManager.TaskManagerTaskBody<PocEventData>): Promise<void> {
  if (error) {
    logger.error('region task error:', error.message);
    return;
  }
  if (!data) return;

  const { eventType, region } = data;
  const stationName = region.identifier ?? '(unknown)';
  if (eventType === Location.GeofencingEventType.Enter) {
    logger.info('region enter:', stationName);
    logRegionEntryFired({ stationName, kind: 'station-passed', phaseId: 'imminent' });
    return;
  }
  if (eventType === Location.GeofencingEventType.Exit) {
    logger.info('region exit:', stationName);
    return;
  }
  logger.warn('unknown region eventType:', eventType);
}

TaskManager.defineTask(REGION_POC_TASK, handleRegionEvent);

// ── 등록 상태 추적 — DebugModal/진단용 (silent push 패턴 답습) ──
export type PocRegistrationState = 'unknown' | 'success' | 'failed';
interface PocStatus {
  state: PocRegistrationState;
  error: string | null;
  monitoredCount: number;
}
let pocStatus: PocStatus = { state: 'unknown', error: null, monitoredCount: 0 };

export function getRegionPocStatus(): PocStatus {
  return pocStatus;
}

/** 테스트 격리용 — production code에선 호출 금지. */
export function __resetRegionPocStatusForTest(): void {
  pocStatus = { state: 'unknown', error: null, monitoredCount: 0 };
}

/**
 * PoC region 모니터링을 시작한다.
 * iOS 앱당 region 20개 한계 — caller가 5개 정도로 제한하는 것을 권장(여유 두고 측정).
 */
export async function startRegionMonitoringPoc(regions: readonly PocRegion[]): Promise<void> {
  try {
    await Location.startGeofencingAsync(
      REGION_POC_TASK,
      regions.map((r) => ({
        identifier: r.identifier,
        latitude: r.latitude,
        longitude: r.longitude,
        radius: r.radius,
        // PoC 핵심 — Enter/Exit 모두 받아 분석.
        notifyOnEnter: true,
        notifyOnExit: true,
      })),
    );
    pocStatus = { state: 'success', error: null, monitoredCount: regions.length };
    logger.info(`region PoC started: ${regions.length} regions`);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    pocStatus = { state: 'failed', error: message, monitoredCount: 0 };
    logger.warn('region PoC start failed:', e);
  }
}

/** PoC region 모니터링을 중단한다(앱 재시작/PoC 종료 시 호출). */
export async function stopRegionMonitoringPoc(): Promise<void> {
  try {
    const running = await Location.hasStartedGeofencingAsync(REGION_POC_TASK);
    if (running) {
      await Location.stopGeofencingAsync(REGION_POC_TASK);
    }
    pocStatus = { state: 'unknown', error: null, monitoredCount: 0 };
    logger.info('region PoC stopped');
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    pocStatus = { state: 'failed', error: message, monitoredCount: 0 };
    logger.warn('region PoC stop failed:', e);
  }
}
