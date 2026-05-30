import type {
  DirectRoute,
  MultiTransferRoute,
  TransferRoute,
  TransferSegment,
} from '../utils/stationRoute';
import type { LineNumber } from '../types/station';

/**
 * 테스트용 평균 운행 시간 (초/정거장). production은 build-transfer-times.js 실측 lookup,
 * fixture는 충분히 일관된 평균치(120s)로 충분 — getTravelMinutes 등 시간 계산이 의미를 잃지 않으면 됨.
 */
const STOP_FALLBACK_SECONDS = 120;

export function makeDirectRoute(stops: number, line: LineNumber): DirectRoute {
  return {
    type: 'direct',
    stops,
    line,
    travelSeconds: stops * STOP_FALLBACK_SECONDS,
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
  return {
    type: 'multi-transfer',
    transfers: input.transfers.map(makeTransferSegment),
    stopsAfterLastTransfer: input.stopsAfterLastTransfer,
    secondsAfterLastTransfer: input.stopsAfterLastTransfer * STOP_FALLBACK_SECONDS,
  };
}
