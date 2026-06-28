import { createDebugBuffer } from '../../../shared/utils/createDebugBuffer';
import type { LineNumber } from '../../../shared/types/station';

/**
 * #1902 (2026-06-26 RC-18) — candidate reject 전용 ring buffer.
 *
 * 배경: fusionDebugBuffer(cap=200) 단일 채널이 `candidate-reject` entry로 점령되면
 * fusion decision / sticky / gps-fix 등 진단 1순위 entry가 evict되어 사후 분석이 불가능해진다
 * (T4 trip evidence: reject 66건 / 200 cap = 33% 점유).
 *
 * 해결: gpsDropBuffer 패턴과 동일하게 별 buffer로 분리. cap=50은 정상 trip(60+분) 동안의
 * reject(line filter 적용 후) 카운트를 모두 보관하면서도 fusionDebugBuffer cap을 점령하지 않는다.
 *
 * 세 종류:
 *  - `candidate-distance`: 사용자 GPS 거리 hard gate(#1616 R12-a). anchor drift 차단.
 *  - `candidate-line` (#1902): trip route 활성 line 화이트리스트(`allowedLinesFromRoute`)와
 *    무관한 line 후보를 enumerate 단계에서 차단. T4 trip에서 5/6/7호선 + 공항철도 +
 *    경의중앙선 후보 18개 무차별 reject 회귀 차단용.
 *  - `candidate-env` (#1934 G3 option B, #1936 G4 통합): 후보 station.environment가 cascade
 *    environment SSOT와 불일치 시 카운트만 누적 (filter는 #1950 consensus 게이트가 처리).
 *    enumeration 단계 가시화 — DebugModal에서 분포 표시.
 *
 * 세 reason을 같은 buffer로 묶은 이유: 셋 다 사용자 GPS / route / environment 기반 후보 정확도
 * 신호로 진단 시점에 비교 관찰이 유효. DebugModal에서 reason 키별 분포 표시.
 */
export const CANDIDATE_REJECT_BUFFER_CAPACITY = 50;

export type CandidateRejectReason = 'candidate-distance' | 'candidate-line' | 'candidate-env';

export interface CandidateRejectEntry {
  kind: 'candidate-reject';
  ts: number;
  reason: CandidateRejectReason;
  /** trainNo는 `candidate-line`/`candidate-env` reason에서 enumerate 단계 reject라 train picking 전이므로 옵셔널. */
  trainNo?: string;
  /** `candidate-line`/`candidate-env` reason에서 사용자 trip route 외/환경 불일치 후보 station — 진단용. */
  stationName?: string;
  line: LineNumber;
  /** `candidate-distance` reason 한정 — 사용자 GPS와 candidate.currentStation 거리. */
  distanceKm?: number;
  /**
   * `candidate-env` reason 한정 (#1934 G3 option B + #1936 G4) — cascade environment SSOT.
   * 진단 시 candidate.station.environment과 비교해 mismatch 패턴 분석.
   */
  cascadeEnvironment?: 'surface' | 'underground' | 'unknown';
  /**
   * `candidate-env` reason 한정 — candidate.station.environment.
   * undefined/null인 entry는 mismatch에서 제외(보수적) — 본 필드는 채워진 케이스만 측정.
   */
  candidateEnvironment?: 'surface' | 'underground' | 'mixed' | 'unknown';
}

const db = createDebugBuffer<CandidateRejectEntry>(CANDIDATE_REJECT_BUFFER_CAPACITY);

export function pushCandidateRejectEntry(entry: CandidateRejectEntry): void {
  db.push(entry);
}

export function getCandidateRejectEntries(): readonly CandidateRejectEntry[] {
  return db.get();
}

export function clearCandidateRejectEntries(): void {
  db.clear();
}

export function subscribeCandidateReject(listener: () => void): () => void {
  return db.subscribe(listener);
}
