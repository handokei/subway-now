import type { FusionConfidence, FusionSource } from './pickFusedStation';
import { createDebugBuffer } from '../../../shared/utils/createDebugBuffer';

// 측정 인프라(#443): fusion 결정/GPS fix 이벤트를 in-memory ring buffer에 보관.
// 외부 도구(Metro/Xcode) 없이 DebugModal에서 사후 재구성하기 위한 채널.
// 콘솔 logger는 dev 빌드에서만 보이고 스탠드얼론 빌드/현장(지하철)에서는 확인 불가 —
// 그 공백을 메우는 것이 목적.

// #1881 — 60분 trip × ~3 entry/tick(30s) = ~360 entry. 여유 확보 → 500.
export const FUSION_DEBUG_BUFFER_CAPACITY = 500;

/** 후보 신호 — 신호원이 늘면 key를 추가만 하면 됨(타입/포맷터 동시 수정 불필요). */
export interface FusionCandidateMini {
  key: 'positionTrain' | 'fused' | 'route' | 'gps' | 'wifiSsid';
  stationName: string;
  line: string;
  /** 추가 정보 — 출처별 의미가 다를 수 있어 자유형으로 둠.
   *  null은 "값이 없는 컨텍스트"를 명시 (예: positionTrain의 lockedTrainCode=null = lock 비활성). */
  extra?: Record<string, string | number | boolean | null>;
}

export interface FusionDecisionEntry {
  kind: 'fusion';
  ts: number;
  source: FusionSource;
  confidence: FusionConfidence;
  stationName: string | null;
  line: string | null;
  distanceKm: number | null;
  /** push 시점 GPS accuracy — 결정에 직접 쓰였는지와 무관. source가 gps가 아닐 때도
   *  센서 컨디션 진단용으로 같이 본다. 이름에 출처(`gps`)와 시점(`AtPush`)을 박아 오독 방지. */
  gpsAccuracyAtPushMeters: number | null;
  /** 4개 우선순위 후보 raw — 왜 그 source가 선택됐는지 사후 재구성. */
  candidates: FusionCandidateMini[];
  /**
   * #921 — 신호 fusion verdict (3 신호 합의). 본 PR에서는 cascade 비결합 — 측정용으로만 기록.
   *
   * 후속 PR에서 cascade에 합쳐질 때까지 dormant이 아닌 "관찰 가능" 상태 유지 — 실기기에서 어느
   * 신호가 합의에 기여했는지 사후 재구성용. null이면 본 사이클에 fusion 입력 자체가 없음.
   */
  detectionSignals?: {
    detected: boolean;
    confidence: 'high' | 'medium' | 'low';
    signalsAgreed: number;
    signalsAvailable: number;
  } | null;
}

export type GpsFixKind = 'gps-fix' | 'gps-drop';

export interface GpsFixEntry {
  kind: 'gps';
  /** gps-fix: 표시 게이트 통과한 fix가 station 변화. gps-drop: 게이트가 거부. */
  event: GpsFixKind;
  ts: number;
  lat: number;
  lng: number;
  accuracyMeters: number | null;
  speedMps: number | null;
  nearestStation: string | null;
  nearestLine: string | null;
  nearestDistanceKm: number | null;
  /** drop 사유(있을 때만) — "low-accuracy" 등. */
  dropReason?: string;
}

/** #876 — sticky station lock/unlock 이벤트 측정.
 *  현장에서 잘못된 lock 또는 unlock이 발생했는지 사후 재구성하기 위한 채널. */
export type StickyStationEvent =
  | 'locked'
  | 'unlocked-distance'
  | 'unlocked-motion'
  | 'unlocked-ttl'
  | 'unlocked-better-fix'
  // #1317 — 저품질 GPS에서 1km+ 멀어진 다른 역 fix가 N회 연속 관찰돼 unlock.
  | 'unlocked-moved-away'
  // #1317 — 사용자가 지도탭 "현재위치"를 명시적으로 탭해 unlock(live 위치 요청).
  | 'unlocked-manual'
  // #1524 — trip이 종료(tripActive true→false)되면 sticky lock도 즉시 해제.
  // 자동 하차 후 stale lock(예: 현재역=군자 고착) 회귀 차단.
  | 'unlocked-trip-ended';

export interface StickyStationEntry {
  kind: 'sticky';
  event: StickyStationEvent;
  ts: number;
  stationName: string;
  line: string;
  /** locked 시: lock된 fix의 정확도/속도. unlock 시: trigger fix의 정확도/속도(없으면 null). */
  accuracyMeters: number | null;
  speedMps: number | null;
}

/**
 * #1616 (R12-a) candidate distance reject + #1902 (RC-18) candidate line reject는
 * 별 buffer로 분리됐다. `candidateRejectBuffer.ts` 참조.
 *
 * 배경: 단일 ring buffer가 reject entry 점령으로 fusion decision/sticky/gps-fix 진단을
 * 잃는 자기 파괴 회귀(T4 evidence: 66건 / 200 cap = 33%). cap 분리로 진단 1순위 보호.
 */

/**
 * #1896 (RC-8) — boarding-lock GPS displacement gate trigger entry는 별 buffer로 분리됐다.
 * `boardingLockDriftBuffer.ts` 참조. 동기: `candidateRejectBuffer`(#1902, RC-18)와 동일한
 * self-pollution 방지 — stuck 시나리오에서 매 cycle drift entry가 push되어 fusionDebugBuffer
 * 200~500 cap을 점령하면 fusion decision/sticky/gps-fix 진단 1순위 entry가 evict된다.
 */

/**
 * #2125 — 현재역 표시 고착 정직 강등 이벤트. sticky lock이 trip 시작역에 고정된 채
 * CURRENT_STATION_STALE_DEMOTE_MS 이상 상위 tier advance 없이 경과하면 1건 push.
 * 표시 계층 전용 관측 — fire/알람 경로는 본 entry를 읽지 않는다.
 */
export type DisplayDemoteReason = 'display-demote-sticky-stale';

export interface DisplayDemoteEntry {
  kind: 'display-demote';
  reason: DisplayDemoteReason;
  ts: number;
  stationName: string;
  line: string;
}

export type FusionDebugEntry =
  | FusionDecisionEntry
  | GpsFixEntry
  | StickyStationEntry
  | DisplayDemoteEntry;

const db = createDebugBuffer<FusionDebugEntry>(FUSION_DEBUG_BUFFER_CAPACITY);

export function pushFusionDebugEntry(entry: FusionDebugEntry): void {
  db.push(entry);
}

export function getFusionDebugEntries(): readonly FusionDebugEntry[] {
  return db.get();
}

export function clearFusionDebugEntries(): void {
  db.clear();
}

export function subscribeFusionDebug(listener: () => void): () => void {
  return db.subscribe(listener);
}
