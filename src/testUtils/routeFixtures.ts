import type {
  DirectRoute,
  MultiTransferRoute,
  TransferRoute,
  TransferSegment,
} from '../shared/utils/stationRoute';
import type { LineNumber } from '../shared/types/station';
import stationsData from '../data/stations.json';

/**
 * 테스트용 평균 운행 시간 (초/정거장). production은 build-transfer-times.js 실측 lookup,
 * fixture는 충분히 일관된 평균치(120s)로 충분 — getTravelMinutes 등 시간 계산이 의미를 잃지 않으면 됨.
 */
const STOP_FALLBACK_SECONDS = 120;

/**
 * #3177: 경로 stationId(필수) fixture 기본값 — 해당 노선의 첫 역 id(stations.json). 이름 조회가 아니라
 * 노선 기준 결정적 값이라 하차문 정답과 무관한 테스트에서만 쓴다. 정답 역이 의미 있는 테스트는 입력으로 명시한다.
 */
export function placeholderStationId(line: LineNumber): string {
  return (stationsData as Array<{ id: string; line: string }>).find((s) => s.line === line)!.id;
}

export function makeDirectRoute(stops: number, line: LineNumber): DirectRoute {
  return {
    type: 'direct',
    stops,
    line,
    travelSeconds: stops * STOP_FALLBACK_SECONDS,
    destinationStationId: placeholderStationId(line),
  };
}

export interface MakeTransferRouteInput {
  transferName: string;
  fromLine: LineNumber;
  toLine: LineNumber;
  stopsToTransfer: number;
  stopsFromTransfer: number;
}

export function makeTransferRoute(input: MakeTransferRouteInput): TransferRoute {
  return {
    type: 'transfer',
    transferName: input.transferName,
    transferStationId: placeholderStationId(input.fromLine),
    destinationStationId: placeholderStationId(input.toLine),
    fromLine: input.fromLine,
    toLine: input.toLine,
    stopsToTransfer: input.stopsToTransfer,
    stopsFromTransfer: input.stopsFromTransfer,
    secondsToTransfer: input.stopsToTransfer * STOP_FALLBACK_SECONDS,
    secondsFromTransfer: input.stopsFromTransfer * STOP_FALLBACK_SECONDS,
  };
}

export interface MakeTransferSegmentInput {
  transferName: string;
  fromLine: LineNumber;
  toLine: LineNumber;
  stopsToTransfer: number;
}

export function makeTransferSegment(input: MakeTransferSegmentInput): TransferSegment {
  return {
    transferName: input.transferName,
    transferStationId: placeholderStationId(input.fromLine),
    fromLine: input.fromLine,
    toLine: input.toLine,
    stopsToTransfer: input.stopsToTransfer,
    secondsToTransfer: input.stopsToTransfer * STOP_FALLBACK_SECONDS,
  };
}

export interface MakeMultiTransferRouteInput {
  transfers: MakeTransferSegmentInput[];
  stopsAfterLastTransfer: number;
}

export function makeMultiTransferRoute(
  input: MakeMultiTransferRouteInput,
): MultiTransferRoute {
  const { transfers } = input;
  return {
    type: 'multi-transfer',
    transfers: transfers.map(makeTransferSegment),
    destinationStationId: placeholderStationId(transfers[transfers.length - 1].toLine),
    stopsAfterLastTransfer: input.stopsAfterLastTransfer,
    secondsAfterLastTransfer: input.stopsAfterLastTransfer * STOP_FALLBACK_SECONDS,
  };
}
