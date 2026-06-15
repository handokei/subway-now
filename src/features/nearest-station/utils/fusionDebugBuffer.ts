import type { FusionConfidence, FusionSource } from './pickFusedStation';
import { createDebugBuffer } from '../../../shared/utils/createDebugBuffer';
import { registerDebugBuffer } from '../../../shared/utils/debugBufferRegistry';
import { formatLineTime } from '../../../shared/utils/formatTime';

// 측정 인프라(#443): fusion 결정/GPS fix 이벤트를 in-memory ring buffer에 보관.
// 외부 도구(Metro/Xcode) 없이 DebugModal에서 사후 재구성하기 위한 채널.
// 콘솔 logger는 dev 빌드에서만 보이고 스탠드얼론 빌드/현장(지하철)에서는 확인 불가 —
// 그 공백을 메우는 것이 목적.

export const FUSION_DEBUG_BUFFER_CAPACITY = 200;

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
  | 'unlocked-manual';

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

export type FusionDebugEntry = FusionDecisionEntry | GpsFixEntry | StickyStationEntry;

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

/** candidates key → 짧은 접두어. 새 key 추가 시 여기 한 줄만. */
const CANDIDATE_SHORT: Record<string, string> = {
  positionTrain: 'pt',
  fused: 'fu',
  route: 'rt',
  gps: 'gp',
};

/** #1348 — fusion 엔트리 한 줄 텍스트 포맷. share dump / UI 양쪽 SSOT. */
export function formatFusionDebugLine(entry: FusionDebugEntry): string {
  const time = formatLineTime(entry.ts);
  if (entry.kind === 'gps') {
    const station = entry.nearestStation
      ? `${entry.nearestStation}(${entry.nearestLine ?? '-'})`
      : '-';
    const d = entry.nearestDistanceKm != null ? `${Math.round(entry.nearestDistanceKm * 1000)}m` : '-';
    const acc = entry.accuracyMeters != null ? `${Math.round(entry.accuracyMeters)}m` : '-';
    const reason = entry.dropReason ? ` reason=${entry.dropReason}` : '';
    return `${time} | ${entry.event} | ${station} d=${d} acc=${acc}${reason}`;
  }
  if (entry.kind === 'sticky') {
    const acc = entry.accuracyMeters != null ? `${Math.round(entry.accuracyMeters)}m` : '-';
    const sp = entry.speedMps != null ? `${entry.speedMps.toFixed(1)}m/s` : '-';
    return `${time} | sticky:${entry.event} | ${entry.stationName}(${entry.line}) acc=${acc} sp=${sp}`;
  }
  const station = entry.stationName ? `${entry.stationName}(${entry.line ?? '-'})` : '-';
  const d = entry.distanceKm != null ? `${Math.round(entry.distanceKm * 1000)}m` : '-';
  const acc =
    entry.gpsAccuracyAtPushMeters != null ? `${Math.round(entry.gpsAccuracyAtPushMeters)}m` : '-';
  const cand = entry.candidates
    .map((c) => {
      const base = `${CANDIDATE_SHORT[c.key] ?? c.key}=${c.stationName}`;
      return c.extra?.lockMatch === true ? `${base}[LOCK]` : base;
    })
    .join(' ');
  const candPart = cand.length > 0 ? cand : '-';
  return `${time} | src=${entry.source} conf=${entry.confidence} | ${station} d=${d} acc=${acc} | ${candPart}`;
}

// #1348 — share dump SSOT 등록. module import 시점에 한 번 호출돼 자동 enumerate.
registerDebugBuffer({
  key: 'Fusion log',
  dumpLines: () => getFusionDebugEntries().map(formatFusionDebugLine),
});
