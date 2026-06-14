/* eslint-disable import/no-restricted-paths --
 * Cross-feature: 본 pure 결정 함수는 nearest-station이 소유한 `AutoLockCandidate`를 산출한다
 * (FG hook `useTransferAutoDetect`도 동일 import를 file-level disable로 옵트인). 후속 PR에서
 * orchestration 슬라이스로 이전하며 disable을 제거할 예정 (#1281 본문 명시).
 *
 * ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" Phase 5 (#890).
 */
/**
 * #1281 — route 미설정 환승 자동 detect의 순수 결정 로직.
 *
 * `useTransferAutoDetect`(FG hook)와 `backgroundLocationTask`(BG task)가 동일한 환승-swap 후보
 * 산출 로직을 공유하도록 hook에서 추출한 pure 함수. FG/BG 어느 진입점에서도 같은 신호 결합과
 * false-positive 방어(`detectTransfer`)를 거쳐 결정한다.
 *
 * pure: React/AsyncStorage/네트워크 의존 없음. 호출자가 fusion 결과·arrival·lock·route 컨텍스트를
 * 모두 인자로 전달한다. hook은 결과를 모달/idempotency state와 묶고, BG task는 결과 candidate로
 * `/boarding-lock/sync`를 발사한다.
 *
 * 신호 결합(모두 충족 시 detect, `detectTransfer` 위임):
 *   1) 현재 가장 가까운 역이 환승역(`isTransfer`)
 *   2) motion walking(이동 중)
 *   3) 현재 boardingLine을 제외한 다른 노선의 임박 도착 신호
 *
 * candidate(단일 후보일 때만 산출): backend `/boarding-lock/sync` payload + client hydrate에 쓰는
 * AutoLockCandidate. 다중 후보는 candidateLines로만 노출하고 호출자(FG 모달)가 사용자 선택을 받는다.
 */
import { detectTransfer } from './transferDetect';
import { isExpressStop } from './expressLookup';
import { lineToSubwayId } from '../../../shared/constants/lineApiNames';
import type { OtherLineArrival } from './transferDetect';
import type { AutoLockCandidate } from '../../nearest-station/api/boardingLockSync';
import type { ArrivalInfo, StationArrival } from '../../../shared/types/arrival';
import type { LineNumber, NearestStationsResult } from '../../../shared/types/station';

export interface EvaluateTransferSwapInput {
  /** 현재 fusion된 최근접 역(환승역 후보 포함). */
  readonly nearestStations: NearestStationsResult | null;
  /** 현재 정차 중 여부. `false`/`undefined`(warmup)일 때만 detect 활성. */
  readonly motionStationary: boolean | undefined;
  /** 현재 origin station의 도착 데이터. 다른 노선 후보 추출 입력. */
  readonly arrival: StationArrival | null;
  /** 현재 boardingLock의 노선. 같은 노선 후보는 제외(자기 노선 무한 detect 회피). */
  readonly boardingLine: LineNumber | null;
  /** route 도착역 이름. trainType 우선순위(express 정차 여부) 판정에 사용. */
  readonly destinationName: string | null;
  /**
   * 사용자가 이미 planned route의 transfer waypoint에 있다(기존 환승 list flow가 책임). true면
   * 자동 detect skip. FG hook은 `findActiveTransferContext`로 산출, BG task는 항상 false.
   */
  readonly onPlannedTransfer: boolean;
}

export interface EvaluateTransferSwapResult {
  /** detect된 다른 노선 후보(0/1/N), imminence 정렬. */
  readonly candidateLines: readonly LineNumber[];
  /** 단일 후보일 때만 산출되는 AutoLockCandidate. 0개/다중 후보면 null. */
  readonly candidate: AutoLockCandidate | null;
}

const EMPTY_RESULT: EvaluateTransferSwapResult = { candidateLines: [], candidate: null };

/**
 * 환승-swap 후보를 결정한다. FG hook과 BG task가 공유하는 단일 결정 지점.
 *
 * 단일 후보면 `candidate`를 함께 산출(자동 lock / sync 발사용), 다중 후보면 `candidateLines`만
 * 노출(호출자가 사용자 선택 모달로 연결). detect 실패(0개)면 둘 다 비운다.
 */
export function evaluateTransferSwap(
  input: EvaluateTransferSwapInput,
): EvaluateTransferSwapResult {
  const { nearestStations, motionStationary, arrival, boardingLine, destinationName, onPlannedTransfer } = input;

  if (onPlannedTransfer) return EMPTY_RESULT;

  const otherLineArrivals = collectOtherLineArrivals(arrival, boardingLine);
  const detection = detectTransfer({
    nearestStations,
    motionWalking: !motionStationary,
    otherLineArrivals,
  });
  if (!detection.detected) return EMPTY_RESULT;

  const { candidateLines } = detection;
  if (candidateLines.length !== 1) {
    return { candidateLines, candidate: null };
  }

  const [line] = candidateLines;
  const candidate = buildAutoLockCandidate(line, arrival, destinationName);
  return { candidateLines, candidate };
}

/**
 * arrival.up / down을 평탄화한 뒤 `boardingLine`을 제외하고 OtherLineArrival 배열로 변환.
 * 같은 line의 up/down이 모두 있어도 detectTransfer가 dedup하므로 추가 처리 불필요.
 */
export function collectOtherLineArrivals(
  arrival: StationArrival | null,
  boardingLine: LineNumber | null,
): OtherLineArrival[] {
  if (!arrival) return [];
  const all: ArrivalInfo[] = [...arrival.up, ...arrival.down];
  const out: OtherLineArrival[] = [];
  for (const t of all) {
    if (boardingLine !== null && t.line === boardingLine) continue;
    out.push({ line: t.line, arrivalSeconds: t.arrivalSeconds, arrivalCode: t.arrivalCode });
  }
  return out;
}

/**
 * candidate line의 가장 임박한 trainCode를 사용해 AutoLockCandidate 구성.
 * subwayId 매핑 누락 시 null — 호출자가 hydrate/sync skip.
 *
 * #971: destinationName이 주어지면 trainType이 destination에 정차하는 후보를 우선 선택.
 * 일반정차역만 가능한 destination에서 급행/특급이 통과하는 lock 사고를 회피한다.
 */
export function buildAutoLockCandidate(
  line: LineNumber,
  arrival: StationArrival | null,
  destinationName: string | null,
): AutoLockCandidate | null {
  const subwayId = lineToSubwayId(line);
  /* istanbul ignore next -- 모든 LineNumber는 LINE_TO_SUBWAY_ID에 등록되어 있어 null 분기는
     valid LineNumber 입력 하에서 도달 불가. 타입 보강용 방어. */
  if (!subwayId) return null;
  const trainCode = pickImminentTrainCode(arrival, line, destinationName);
  if (!trainCode) return null;
  return { trainCode, line, subwayId };
}

/**
 * 같은 line의 후보 중 가장 임박한 trainCode 반환.
 *
 * #971: destinationName이 있으면 destination 정차 가능한 trainType을 1차 후보군으로,
 * 그 군이 비면 전체에서 fallback. destinationName=null은 기존 동작(전체에서 imminent).
 *
 * `isExpressStop`은 normal에 대해 항상 true, 데이터 미보유 line/type에 대해 보수적으로 true →
 * 미지의 노선/타입을 사용자에게 무리하게 막지 않는다. 일반정차역 only인 destination에서
 * 정확한 express 정차역 데이터가 있는 경우(예: 1·9호선 급행)에만 express 후보를 제외한다.
 */
function pickImminentTrainCode(
  arrival: StationArrival | null,
  line: LineNumber,
  destinationName: string | null,
): string | null {
  if (!arrival) return null;
  const all: ArrivalInfo[] = [...arrival.up, ...arrival.down];
  let preferred: ArrivalInfo | null = null;
  let fallback: ArrivalInfo | null = null;
  for (const t of all) {
    if (t.line !== line) continue;
    /* istanbul ignore next -- detectTransfer는 음수 arrivalSeconds를 후보에서 제외한 뒤 line을
       반환하므로, 그 line의 음수 train이 있더라도 양수 train이 이미 적어도 하나 존재. 양수만
       best로 선택되어 음수 분기는 도달하지 않는다. 방어 코드. */
    if (t.arrivalSeconds < 0) continue;
    if (!fallback || t.arrivalSeconds < fallback.arrivalSeconds) fallback = t;
    // destination 미설정 → 모든 후보가 preferred와 동등 → fallback만으로 판정.
    if (destinationName === null) continue;
    if (!isExpressStop(destinationName, line, t.trainType)) continue;
    if (!preferred || t.arrivalSeconds < preferred.arrivalSeconds) preferred = t;
  }
  return (preferred ?? fallback)?.trainCode ?? null;
}
