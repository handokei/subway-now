/**
 * 측정 spike (test/#strat4-underground-accuracy) — production 코드 수정 없음.
 *
 * 목적: A1 fallback lock(trainCode pending)에서 estimator ①②가 skip되고 Strategy ④(DefaultHop)만
 * 지하 현재역 추정을 담당하는 상황의 **실제 정확도(drift)** 측정. ①②③를 모두 배제(lastObserved=null,
 * trainProgress=null, nextStationArrivals=[])해 dead-zone(④ 전용 경로)을 강제한다.
 *
 * 앵커: boardingStation=용마산(7-015), boardedAt=2026-08-28 06:26:54 KST.
 * arc(7호선): 용마산(7-015) → 중곡(7-016) → 군자(7-017) → 어린이대공원(7-018).
 * hop time(stationTravelTimes.json 실측, `hopTimeMsAt`로 조회): 각 구간 80s.
 *
 * ground truth(D1 backend cron-fire 시각 = 실제 통과):
 *   중곡      06:29:53 (+179s)
 *   군자      06:31:52 (+298s)
 *   어린이대공원 06:33:53 (+419s)
 *
 * 이 테스트는 결론을 강요하지 않는다 — `estimateStationProgress`가 실제로 반환하는 index를
 * ground-truth index와 대조해 drift를 있는 그대로 기록한다.
 */
import { estimateStationProgress } from '../stationProgressEstimator';
import { hopTimeMsAt } from '../hopTime';
import type { BoardingLock } from '../../../../shared/types/boardingLock';
import type { Station } from '../../../../shared/types/station';

const ARC: Station[] = [
  { id: '7-015', name: '용마산', line: '7', lineColor: '#747F00', lat: 37.573647, lng: 127.086727 },
  { id: '7-016', name: '중곡', line: '7', lineColor: '#747F00', lat: 37.565923, lng: 127.08432 },
  { id: '7-017', name: '군자(능동)', line: '7', lineColor: '#747F00', lat: 37.556897, lng: 127.079338 },
  { id: '7-018', name: '어린이대공원(세종대)', line: '7', lineColor: '#747F00', lat: 37.548014, lng: 127.074658 },
];

// KST(UTC+9) 2026-08-28 06:26:54 → epoch ms.
const BOARDED_AT = Date.UTC(2026, 7, 27, 21, 26, 54); // 21:26:54 UTC = 06:26:54 KST(다음날)

const LOCK: BoardingLock = {
  destinationId: 'dest',
  trainCode: 'PENDING', // A1 fallback lock — trainCode 미확정 → ①②는 애초에 매칭 불가
  boardingStationId: '7-015',
  boardingLine: '7',
  boardedAt: BOARDED_AT,
  expectedDurationMs: 10 * 60 * 1000,
};

const hopTimeMsForHop = (fromIdx: number) => hopTimeMsAt(ARC, fromIdx, '7');

interface GroundTruthCase {
  label: string;
  offsetSec: number;
  groundTruthIndex: number;
}

const GROUND_TRUTH: GroundTruthCase[] = [
  { label: '중곡 실제 통과', offsetSec: 179, groundTruthIndex: 1 },
  { label: '군자 실제 통과', offsetSec: 298, groundTruthIndex: 2 },
  { label: '어린이대공원 실제 통과', offsetSec: 419, groundTruthIndex: 3 },
];

describe('Strategy ④ (DefaultHop) 지하 정확도 측정 — 7호선 용마산→어린이대공원 실탑승 fixture', () => {
  it.each(GROUND_TRUTH)(
    '$label(+$offsetSec s) 시점 — ④ 추정 index vs ground-truth index',
    ({ offsetSec, groundTruthIndex }) => {
      const now = BOARDED_AT + offsetSec * 1000;
      const result = estimateStationProgress({
        lock: LOCK,
        arcStations: ARC,
        now,
        // ①②③ 모두 강제 배제 — dead zone(④ 전용) 재현.
        trainProgress: null,
        lockedTrainCode: null, // trainCode pending → ①②는 애초에 skip
        lastObserved: null, // ③ 재앵커 신호 없음
        hopTimeMsForHop,
        nextStationArrivals: [],
        arrivalEtaTtlMs: 60_000,
        currentIdxHint: null,
      });

      // 리포트용 — jest 콘솔에 drift 표를 남긴다 (PR 본문 표 산출 근거).
      const estimatedIndex = result?.index ?? null;
      const driftStations = estimatedIndex == null ? null : estimatedIndex - groundTruthIndex;
      // eslint-disable-next-line no-console -- 측정 spike, 결과를 정직하게 로그로 남긴다
      console.log(
        `[strategy4-drift] +${offsetSec}s ground-truth=${ARC[groundTruthIndex].name}(idx${groundTruthIndex}) ` +
          `estimated=${result ? `${result.station.name}(idx${estimatedIndex})/${result.strategy}` : 'null'} ` +
          `drift(station)=${driftStations ?? 'N/A'}`,
      );

      // Strategy는 ④(default-hop)여야 dead zone 재현이 유효 — 다른 전략으로 새면 측정이 무의미.
      expect(result?.strategy).toBe('default-hop');
    },
  );

  it('drift 요약 — Seam B 안전 cap(boardingIdx+1)으로 인해 ④는 boarding+1을 넘지 않는다', () => {
    // 세 시점 모두 측정해 진행 패턴을 확인. Seam B cap(`tryDefaultHop`의
    // `Math.min(idx, boardingIdx + 1)`)이 실제로 어떻게 작동하는지 실측.
    const results = GROUND_TRUTH.map(({ offsetSec, groundTruthIndex, label }) => {
      const now = BOARDED_AT + offsetSec * 1000;
      const result = estimateStationProgress({
        lock: LOCK,
        arcStations: ARC,
        now,
        trainProgress: null,
        lockedTrainCode: null,
        lastObserved: null,
        hopTimeMsForHop,
        nextStationArrivals: [],
        arrivalEtaTtlMs: 60_000,
        currentIdxHint: null,
      });
      return {
        label,
        offsetSec,
        groundTruthIndex,
        estimatedIndex: result?.index ?? null,
      };
    });

    // eslint-disable-next-line no-console -- 측정 spike 표 출력
    console.table(results);

    // 실측 확인: cap 때문에 어느 시점에도 boardingIdx(0) + 1 = 1을 초과하지 않는다.
    for (const r of results) {
      expect(r.estimatedIndex).not.toBeNull();
      expect(r.estimatedIndex as number).toBeLessThanOrEqual(1);
    }
  });
});
