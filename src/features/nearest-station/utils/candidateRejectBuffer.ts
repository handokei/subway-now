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
  /**
   * #2093 (G) — 집계 윈도우 내 reject 총 건수. 1(기본, 미설정과 동일 취급)이면 개별 entry,
   * 2 이상이면 같은 reason이 `CANDIDATE_REJECT_AGGREGATION_WINDOW_MS` 안에 반복 reject되어
   * 이 entry로 요약된 것 — `DebugModal.formatCandidateRejectLine`이 `×N` suffix로 표시한다.
   */
  count?: number;
}

const db = createDebugBuffer<CandidateRejectEntry>(CANDIDATE_REJECT_BUFFER_CAPACITY);

/**
 * #2093 (G) — candidate-distance-reject / candidate-env reject burst 집계 윈도우.
 *
 * 배경: 7/7·7/8 실기기 로그에서 trip 비활성 화면(먼 역 다수)에 1초 안에 distance-reject
 * 28건, 2Hz로 env-reject 44건이 쏟아짐 — 판정 자체는 정상 동작(#1902/#1934)이지만 매 건을
 * 개별 entry로 push하면 cap=50 ring buffer가 burst 한 번에 점령돼 다른 시점 진단 이력이
 * evict된다(위 파일 헤더 T4 evidence와 동일 메커니즘, gpsDropBuffer/lesson_gps_drop_fusion_buffer_pollution
 * burst dedup 패턴 재사용).
 *
 * 구현: reason별 슬라이딩 윈도우 상태를 유지한다. 윈도우 시작 시 첫 reject만 실제 push(count=1),
 * 같은 윈도우 안의 후속 reject는 새 slot을 소모하지 않고 이미 push된 entry 객체를 **in-place
 * 갱신**(count 증가, distanceKm은 최대값 유지, station/line/env는 최신값 반영)한다 — ring buffer가
 * 참조를 그대로 들고 있으므로 추가 push 없이 `getCandidateRejectEntries()`가 항상 최신 집계를
 * 반환한다. 윈도우 경과 후 다음 reject는 새 윈도우로 취급해 새 entry를 push한다(count=1부터 재시작).
 */
export const CANDIDATE_REJECT_AGGREGATION_WINDOW_MS = 10_000;

interface RejectAggregationWindow {
  windowStart: number;
  maxDistanceKm: number | undefined;
  /** 이번 윈도우에서 db에 push된 entry 객체 참조 — in-place 갱신 대상. */
  entry: CandidateRejectEntry;
}

const windowByReason = new Map<CandidateRejectReason, RejectAggregationWindow>();

export function pushCandidateRejectEntry(entry: CandidateRejectEntry): void {
  const active = windowByReason.get(entry.reason);
  const isNewWindow =
    !active || entry.ts - active.windowStart >= CANDIDATE_REJECT_AGGREGATION_WINDOW_MS;

  if (isNewWindow) {
    const fresh: CandidateRejectEntry = { ...entry, count: 1 };
    windowByReason.set(entry.reason, {
      windowStart: entry.ts,
      maxDistanceKm: entry.distanceKm,
      entry: fresh,
    });
    db.push(fresh);
    return;
  }

  // 같은 윈도우 내 반복 reject — 집계만 갱신, 새 slot push 없음.
  active.maxDistanceKm =
    entry.distanceKm === undefined
      ? active.maxDistanceKm
      : Math.max(active.maxDistanceKm ?? entry.distanceKm, entry.distanceKm);
  // active.entry.count는 새 윈도우 생성 시 항상 1로 초기화되므로 non-null 단언이 안전하다.
  active.entry.count = (active.entry.count as number) + 1;
  active.entry.ts = entry.ts;
  active.entry.distanceKm = active.maxDistanceKm;
  active.entry.trainNo = entry.trainNo ?? active.entry.trainNo;
  active.entry.stationName = entry.stationName ?? active.entry.stationName;
  active.entry.line = entry.line;
  active.entry.cascadeEnvironment = entry.cascadeEnvironment ?? active.entry.cascadeEnvironment;
  active.entry.candidateEnvironment = entry.candidateEnvironment ?? active.entry.candidateEnvironment;
}

export function getCandidateRejectEntries(): readonly CandidateRejectEntry[] {
  return db.get();
}

export function clearCandidateRejectEntries(): void {
  windowByReason.clear();
  db.clear();
}

export function subscribeCandidateReject(listener: () => void): () => void {
  return db.subscribe(listener);
}
