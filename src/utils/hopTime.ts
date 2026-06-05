import { getStopSeconds } from './stationRoute';
import { HOP_TIME_MS } from '../shared/constants/boardingLock';
import type { LineNumber, Station } from '../types/station';

/**
 * ADR-008 Stage 3(#779) — hop time 데이터 룩업.
 *
 * `HOP_TIME_MS = 90_000` 매직넘버는 BoardingProgress estimator(③ ReanchoredHop / ④ DefaultHop)에서
 * 시간 적분 기준값으로 쓰였으나 서울 지하철 실측은 노선·구간별 60~270초 분포 → ±45초 hop 편향이
 * 누적되어 "현재역이 1~2개역 앞서감"의 한 축이 되었다(ADR-008 §② 참조).
 *
 * 본 모듈은 `src/data/stationTravelTimes.json`(#655 도입, 서울 열린데이터 StationDstncReqreTimeHm)을
 * `getStopSeconds`로 룩업해 ms 단위 hop time을 돌려준다. 데이터 미커버 노선/구간(9호선/공항철도/
 * 경의중앙선 등)은 `getStopSeconds` 내부에서 120s fallback이지만, estimator는 더 보수적인
 * 90s(`HOP_TIME_MS`) graceful fallback이 필요한 케이스(예: arc 경계 밖)도 있어 본 모듈에서
 * 케이스별로 분리한다.
 *
 * 데이터 보강은 별도 트랙(9호선 급행 등) — 본 PR scope 아님.
 */

/**
 * line의 fromId → toId 단일 hop을 ms로 반환.
 * `getStopSeconds`가 데이터 미스 시 `STOP_FALLBACK_SECONDS = 120` 반환 — 노선별 평균 보강은 후속.
 */
export function hopTimeMsForSegment(line: LineNumber, fromId: string, toId: string): number {
  return getStopSeconds(line, fromId, toId) * 1000;
}

/**
 * arcStations 위 `fromIdx`에서 다음 역으로의 hop time(ms). arc 경계(`fromIdx`가 마지막 인덱스
 * 또는 음수)이거나 인접 두 역의 line이 다르면 `HOP_TIME_MS` graceful fallback.
 *
 * estimator의 ReanchoredHop / DefaultHop이 시간 적분 시 매 hop마다 호출 — segment별 누적으로
 * "uniform 90s/hop" 대신 실측 가중 hop으로 흐름.
 *
 * line 인자: arc는 BoardingLock 1개 leg(단일 노선) 위에서 생성되므로 lock.boardingLine을 사용한다.
 * 호출자는 lock으로부터 line을 추출해 전달 — 본 함수는 line 결정에 관여하지 않는다(SRP).
 *
 * 두 fallback의 의도적 분리:
 *  - 경계 fallback = `HOP_TIME_MS`(90s) — estimator over-terminal grace의 종착 cap+grace 산식과 정렬.
 *  - mid-arc 데이터 미스 = `STOP_FALLBACK_SECONDS`(120s, getStopSeconds 내부) — 노선 평균 보강 전 보수치.
 */
export function hopTimeMsAt(arcStations: readonly Station[], fromIdx: number, line: LineNumber): number {
  if (fromIdx < 0 || fromIdx >= arcStations.length - 1) return HOP_TIME_MS;
  const from = arcStations[fromIdx];
  const to = arcStations[fromIdx + 1];
  return hopTimeMsForSegment(line, from.id, to.id);
}

/**
 * `anchorIdx`에서 출발해 `elapsedMs` 안에 통과한 hop 수. segment별 hop time을 누적한다 —
 * uniform `Math.floor(elapsedMs / HOP_TIME_MS)` 대체.
 *
 * elapsedMs ≤ 0이면 0(시계 후진은 호출자가 별도 판정). 다음 hop의 누적 시간이 elapsedMs를 초과하면
 * 거기서 멈춘다 — `floor` 의미 보존.
 *
 * `hopTimeMsForHop`은 `(fromIdx) => ms` closure. estimator가 `lock.boardingLine`을 캡슐화한 closure를
 * 주입하므로 본 함수는 line 결정에 관여하지 않는다(SRP). 테스트에서는 monkeypatch가 쉬워진다.
 *
 * arc 끝을 넘는 hop(`fromIdx >= arcLength - 1`)도 `HOP_TIME_MS` 기본값으로 카운트한다 — 호출자(estimator)
 * 가 종착 cap+grace 검사에서 "정상 trip 종료 후 추가로 흐른 hop"을 식별하려면 hops 카운트가 정직하게
 * 누적되어야 한다(arc 끝에서 멈추면 cap이 트리거되지 않는다).
 */
export function hopsElapsedFrom(
  arcLength: number,
  anchorIdx: number,
  elapsedMs: number,
  hopTimeMsForHop: (fromIdx: number) => number,
): number {
  if (elapsedMs <= 0) return 0;
  let consumed = 0;
  let hops = 0;
  let cursor = anchorIdx;
  while (consumed < elapsedMs) {
    const stepMs = cursor < arcLength - 1 ? hopTimeMsForHop(cursor) : HOP_TIME_MS;
    if (consumed + stepMs > elapsedMs) break;
    consumed += stepMs;
    hops++;
    cursor++;
  }
  return hops;
}
