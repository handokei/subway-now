/**
 * #1281 — 백그라운드 환승 자동 detect.
 *
 * FG의 `useTransferAutoDetect`는 화면이 켜져 있을 때만 동작한다(HomeScreen mount). 주머니 속(BG)
 * 환승에서는 detect 진입점이 없어 옛 노선 lock이 backend auto-end(~10분)까지 얼어붙고, 새 노선
 * lock은 사용자가 "탑승 열차"를 직접 탭해야만 활성화됐다(실기기 7→2호선 건대입구 trip, auto 환승 0건).
 *
 * 본 함수는 BG tick에서 동일한 `evaluateTransferSwap`(FG와 공유 pure 결정)을 돌려 환승-swap 후보를
 * 잡고, 후보가 있으면 backend `/boarding-lock/sync`에 새 노선 trainCode를 통보한다. backend가 새
 * trainCode를 관측하면 W1(#1271) 경로로 swap을 적용하고 `autoLockCandidate.from='transfer-swap'`을
 * **sync 응답에 직접** 실어 돌려준다.
 *
 * #2268 (2026-08-10 실탑승 RCA) — 과거 구현은 이 응답을 버리고 "silent push가 hydrate할 것"이라
 * 가정했으나, silent push는 autoLockCandidate를 소비하는 채널이 아니라 지하 환경에서 도착 자체가
 * 죽는 독립 실패 지점이었다(`lesson_silent_push_ssot_forward_no_independent_channel`). 그 결과
 * BG 환승에서 새 노선 lock이 영영 안 붙어 무보호 상태가 됐다. 본 함수는 이제 sync 응답의
 * `autoLockCandidate`를 직접 소비해 `deps.hydrateLock`으로 lock을 hydrate한다 — FG
 * (`useBoardingLockSync` → `hydrateLockFromCandidate`)와 동일하게 HTTP 응답을 SSOT로 쓴다.
 *
 * 의존성은 모두 주입한다(테스트 가능 + route 슬라이스가 nearest-station/arrival/alarm를 직접
 * import하지 않게): 호출자(backgroundLocationTask, cross-feature 옵트인 파일)가
 * provider/sync/lookup/hydrate를 넘긴다.
 *
 * false-positive 방어는 `evaluateTransferSwap`(=`detectTransfer`)의 기존 게이트를 그대로 재사용한다:
 *   1) 현재 최근접 역이 환승역  2) motion walking(이동 중)  3) 현재 boardingLine 제외 다른 노선의
 *   임박 도착. 셋을 모두 충족할 때만 후보가 산출되므로 같은 노선 직진(비환승) trip은 발사하지 않는다.
 *
 * arrival fetch 비용 절감: lock 활성 + 최근접 역이 환승역일 때만 1회 조회한다(매 tick 폴링 X).
 */
import { evaluateTransferSwap } from './transferSwap';
import type { ArrivalProvider } from '../../../shared/types/providers';
import type { BoardingLock } from '../../../shared/types/boardingLock';
import type { NearestStationsResult } from '../../../shared/types/station';

/** `/boarding-lock/sync` 발사에 필요한 payload(호출자의 syncBoardingLock 시그니처 부분집합). */
export interface BackgroundTransferSwapSyncPayload {
  token: string;
  observedStationName: string;
  observedAtMs: number;
  accuracy: number;
  trainCode: string;
  boardingLine: string;
}

/**
 * #2268 — `nearest-station/api/boardingLockSync.ts`의 `AutoLockCandidate` 구조적 부분집합.
 * route 슬라이스가 nearest-station의 타입을 직접 import하지 않도록(cross-feature 경계) 여기서
 * 구조적으로 재정의한다 — 실제 호출자(backgroundLocationTask)가 넘기는 값은 그 타입 그대로다.
 */
export interface BackgroundTransferSwapAutoLockCandidate {
  trainCode: string;
  line: string;
  subwayId: string;
  from?: 'transfer-swap';
}

/** `syncBoardingLock` 응답에서 본 함수가 소비하는 부분집합. */
export interface BackgroundTransferSwapSyncResult {
  autoLockCandidate?: BackgroundTransferSwapAutoLockCandidate | null;
}

export interface BackgroundTransferSwapDeps {
  /** 좌표 → fusion 최근접 역(환승 여부 포함). nearest-station feature에서 주입. */
  findNearestStations: (lat: number, lng: number) => NearestStationsResult | null;
  /** arrival provider. 환승역 도착 정보 1회 조회용. */
  arrivalProvider: ArrivalProvider;
  /** backend sync 발사. 호출자(BG task)가 nearest-station API를 래핑해 주입. */
  syncBoardingLock: (
    payload: BackgroundTransferSwapSyncPayload,
  ) => Promise<BackgroundTransferSwapSyncResult>;
  /**
   * #2268 — sync 응답에 `autoLockCandidate`가 실려오면 호출. 호출자(BG task)가 alarm 슬라이스의
   * lock store로 hydrate한다. 미주입(undefined)이면 hydrate 자체를 skip — 기존 호출자/테스트가
   * 깨지지 않도록 optional로 둔다.
   */
  hydrateLock?: (
    candidate: BackgroundTransferSwapAutoLockCandidate,
    context: { stationName: string },
  ) => void;
}

export interface BackgroundTransferSwapInput {
  lat: number;
  lng: number;
  accuracy: number;
  observedAtMs: number;
  /** APNs device token. backend sync 키. */
  apnsToken: string;
  /** 현재 활성 boarding lock. null이면 환승 detect 대상 trip이 아님. */
  lock: BoardingLock | null;
  /** BG motion 신호 — `getCurrentMotionStationary()` 결과. */
  motionStationary: boolean;
  /** route 도착역 이름(있으면 express 정차 우선순위 판정). */
  destinationName: string | null;
}

export interface BackgroundTransferSwapResult {
  /** swap 후보를 잡아 sync를 발사했는지. 테스트/로그용. */
  fired: boolean;
  /** 발사한 새 노선 trainCode(있으면). */
  trainCode?: string;
}

const NO_SWAP: BackgroundTransferSwapResult = { fired: false };

/**
 * 직전 sync를 발사한 (환승역 + lock leg) 키. 같은 leg lock으로 같은 환승역에 머무는 동안 매 BG tick
 * 마다 arrival 조회 + sync를 재발사하는 churn을 막는다(FG `useBoardingLockSync`의 lastSent ref 패턴).
 * silent push가 새 leg를 hydrate하면 lock.boardingLine/boardingStationId가 바뀌어 키가 달라지고
 * 다음 환승이 다시 허용된다. lock 해제(trip 종료) 시 reset.
 */
let lastFiredKey: string | null = null;

/** 테스트 격리용 — 모듈 상태 초기화. production 경로에서는 호출하지 않는다. */
export function resetBackgroundTransferSwapState(): void {
  lastFiredKey = null;
}

/**
 * BG 환승-swap 평가 + sync 발사. 후보가 없으면 no-op({fired:false}).
 *
 * 게이트 순서(저비용 → 고비용):
 *   1) lock 활성 (없으면 추적 대상 trip 아님 — lastFiredKey reset)
 *   2) 최근접 역이 환승역 (arrival fetch 비용 게이트)
 *   3) 같은 환승역 + 같은 leg lock으로 이미 발사했으면 skip (arrival 재조회 churn 차단)
 *   4) 환승역 arrival 1회 조회 → `evaluateTransferSwap`로 다른 노선 임박 + walking 결합 판정
 *   5) 단일 후보(=새 노선 trainCode)면 backend sync 발사
 *   6) sync 응답에 autoLockCandidate가 있으면 `deps.hydrateLock`으로 직접 hydrate (#2268)
 */
export async function evaluateBackgroundTransferSwap(
  input: BackgroundTransferSwapInput,
  deps: BackgroundTransferSwapDeps,
): Promise<BackgroundTransferSwapResult> {
  const { lat, lng, accuracy, observedAtMs, apnsToken, lock, motionStationary, destinationName } = input;
  if (!lock) {
    lastFiredKey = null;
    return NO_SWAP;
  }

  const nearestStations = deps.findNearestStations(lat, lng);
  if (!nearestStations || !nearestStations.isTransfer) return NO_SWAP;

  // 환승역 arrival 1회 조회. lineHint는 현재 lock 노선 — schedule fallback의 환승역 첫 매칭
  // 부정확성을 줄인다. realtime 성공 경로엔 영향 없음. 조회 실패는 graceful no-op.
  const stationName = nearestStations.primary.name;
  const fireKey = `${lock.boardingStationId}|${lock.boardingLine}|${stationName}`;
  if (lastFiredKey === fireKey) return NO_SWAP;
  let arrival = null;
  try {
    arrival = await deps.arrivalProvider.getArrival(stationName, { lineHint: lock.boardingLine });
  } catch {
    return NO_SWAP;
  }

  const { candidate } = evaluateTransferSwap({
    nearestStations,
    motionStationary,
    arrival,
    boardingLine: lock.boardingLine,
    destinationName,
    // BG에는 useTransferTrainList 같은 planned-transfer UI context가 없으므로 항상 false.
    onPlannedTransfer: false,
  });
  if (!candidate) return NO_SWAP;

  // backend가 새 trainCode(≠ 현재 lock)를 관측하면 W1(#1271) swap 경로로 from='transfer-swap'
  // candidate를 발급한다. candidate.line은 boardingLine 제외 후 산출돼 항상 다른 노선 → 다른 trainCode.
  lastFiredKey = fireKey;
  const response = await deps.syncBoardingLock({
    token: apnsToken,
    observedStationName: stationName,
    observedAtMs,
    accuracy,
    trainCode: candidate.trainCode,
    boardingLine: candidate.line,
  });

  // #2268 — 응답에 autoLockCandidate가 실려오면 직접 hydrate. silent push 채널에 더 이상 의존하지
  // 않는다(그 채널은 지하 환경에서 도착 자체가 죽는 독립 실패 지점이었다).
  if (response?.autoLockCandidate) {
    deps.hydrateLock?.(response.autoLockCandidate, { stationName });
  }

  return { fired: true, trainCode: candidate.trainCode };
}
