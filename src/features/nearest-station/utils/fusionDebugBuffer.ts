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
 * #1616 (R12-a) — candidate별 GPS 거리 hard gate가 reject한 entry.
 *
 * pickCandidateTrains에서 anchorIdx ± window 통과 후 candidate.currentStation의 GPS 좌표가
 * 사용자 마지막 known location 기준 CANDIDATE_DISTANCE_THRESHOLD_KM(3.0km)을 초과해 reject된
 * 케이스. anchor GPS drift 시 잘못된 영역 train이 후보 진입하는 cascade(2026-06-19 trip evidence:
 * pt/fu/gp 다 이수) 차단을 사후 측정.
 *
 * fusion decision과 분리한 이유: reject 자체는 결정 entry가 아니라 입력 단계 reject. fusion
 * decision 이력과 합치면 DebugModal 시각화에서 둘이 섞여 신호 구분 어려움.
 */
export interface CandidateRejectEntry {
  kind: 'candidate-reject';
  ts: number;
  /** reject 사유 — 후속 확장 가능 (예: 'lockless-direction-reject' 등). */
  reason: 'candidate-distance';
  trainNo: string;
  stationName: string;
  line: string;
  distanceKm: number;
}

export type FusionDebugEntry =
  | FusionDecisionEntry
  | GpsFixEntry
  | StickyStationEntry
  | CandidateRejectEntry;

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
