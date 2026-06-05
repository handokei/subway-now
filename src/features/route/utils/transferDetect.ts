/**
 * #924 — route 미설정 환승 자동 detect (D1, 첫 PR: pure 알고리즘).
 *
 * 목적: 사용자가 route(목적지)를 설정하지 않은 free trip에서도 환승을 자동으로 잡는다.
 * Seam F의 사전 정의 route 위 swap만으로는 free trip 환승 미해결 — destination 안 정한 사용자도 진짜 free하려면 필요.
 *
 * 첫 PR 범위: pure JS detect 알고리즘만. 호출 wire(stationRoute 확장, A1 자동 lock, F4 모달)는 후속 PR.
 *
 * 신호 결합(모두 충족 시 detect):
 *   1) 현재 가장 가까운 역이 환승역(`isTransfer === true`) — 환승역 코너에 있어야 환승 가능
 *   2) motion walking(이동 중) — 가만히 있으면 환승이 아니라 단순 정차/대기
 *   3) 다른 노선의 강한 도착 신호 — 임박 도착 ArrivalRow 1개 이상
 *
 * #921(signal fusion) 머지 후에는 fusion 패턴으로 가중치 결합으로 강화 예정. 첫 PR은 단순 AND.
 *
 * candidateLines: 임박 도착이 잡힌 다른 노선들 — 다중 후보일 때 F4 모달(#914)에서 사용자에게 선택지 제공.
 */
import type { LineNumber, NearestStationsResult } from '../../../shared/types/station';

/** 다른 노선 도착이 "임박"으로 간주되는 최대 초. 이 이내 도착이면 환승 후보로 가산. */
export const TRANSFER_DETECT_IMMINENT_SECONDS = 180;

export interface OtherLineArrival {
  line: LineNumber;
  arrivalSeconds: number;
}

export interface DetectTransferInput {
  /** 현재 fusion된 최근접 역(환승역 후보 포함). null이면 GPS 미가용 → detect 불가. */
  nearestStations: NearestStationsResult | null;
  /** motion=walking 패턴(이동 중). `getCurrentMotionStationary()`의 negation을 호출자가 전달. */
  motionWalking: boolean;
  /**
   * 다른 노선의 도착 신호. 호출자는 현재 boarding line을 제외한 다른 노선만 추려서 전달.
   * 같은 노선이 여러 번 와도 OK — 임박 1개라도 있으면 그 노선이 candidate.
   */
  otherLineArrivals: OtherLineArrival[];
}

export interface DetectTransferResult {
  detected: boolean;
  /** 임박 도착이 감지된 다른 노선들(dedup, 입력 순서 보존). */
  candidateLines: LineNumber[];
}

const EMPTY_RESULT: DetectTransferResult = { detected: false, candidateLines: [] };

export function detectTransfer(input: DetectTransferInput): DetectTransferResult {
  const { nearestStations, motionWalking, otherLineArrivals } = input;

  if (!nearestStations || !nearestStations.isTransfer) return EMPTY_RESULT;
  if (!motionWalking) return EMPTY_RESULT;

  const candidateLines = collectImminentLines(otherLineArrivals);
  if (candidateLines.length === 0) return EMPTY_RESULT;

  return { detected: true, candidateLines };
}

function collectImminentLines(arrivals: OtherLineArrival[]): LineNumber[] {
  const seen = new Set<LineNumber>();
  const out: LineNumber[] = [];
  for (const a of arrivals) {
    if (a.arrivalSeconds > TRANSFER_DETECT_IMMINENT_SECONDS) continue;
    if (a.arrivalSeconds < 0) continue;
    if (seen.has(a.line)) continue;
    seen.add(a.line);
    out.push(a.line);
  }
  return out;
}
