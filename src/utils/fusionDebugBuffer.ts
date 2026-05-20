import type { FusionConfidence, FusionSource } from './pickFusedStation';

// 측정 인프라(#443): fusion 결정/GPS fix 이벤트를 in-memory ring buffer에 보관.
// 외부 도구(Metro/Xcode) 없이 DebugModal에서 사후 재구성하기 위한 채널.
// 콘솔 logger는 dev 빌드에서만 보이고 스탠드얼론 빌드/현장(지하철)에서는 확인 불가 —
// 그 공백을 메우는 것이 목적.

export const FUSION_DEBUG_BUFFER_CAPACITY = 200;

/** 후보 신호 — 신호원이 늘면 key를 추가만 하면 됨(타입/포맷터 동시 수정 불필요). */
export interface FusionCandidateMini {
  key: 'positionTrain' | 'fused' | 'route' | 'gps';
  stationName: string;
  line: string;
  /** 추가 정보 — 출처별 의미가 다를 수 있어 자유형으로 둠. */
  extra?: Record<string, string | number>;
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

export type FusionDebugEntry = FusionDecisionEntry | GpsFixEntry;

type Listener = () => void;

const buffer: FusionDebugEntry[] = [];
const listeners = new Set<Listener>();

function emit(): void {
  for (const l of listeners) l();
}

export function pushFusionDebugEntry(entry: FusionDebugEntry): void {
  buffer.push(entry);
  if (buffer.length > FUSION_DEBUG_BUFFER_CAPACITY) {
    buffer.splice(0, buffer.length - FUSION_DEBUG_BUFFER_CAPACITY);
  }
  emit();
}

export function getFusionDebugEntries(): readonly FusionDebugEntry[] {
  return buffer;
}

export function clearFusionDebugEntries(): void {
  if (buffer.length === 0) return;
  buffer.length = 0;
  emit();
}

export function subscribeFusionDebug(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
