/**
 * #3155 — backend 출발 열차(앵커역 최근 10분) → BoardingTrainList "이미 출발" 행.
 *
 * 행의 `train`은 탭 시 기존 수동 탭 경로(`onSelect` → createLockFromTrain/createTransferLock → sync)에
 * 그대로 태울 수 있는 ArrivalInfo다. 시간은 모르므로(arrivalSeconds null) lock의 지연 칩 기준이 생기지 않는다.
 */
import { ARRIVAL_CODE } from '../../../shared/constants/arrivalCodes';
import { DEPARTED_TRAIN_WINDOW_MS } from '../../../shared/constants/departedTrains';
import type { ArrivalInfo } from '../../../shared/types/arrival';
import type { LineNumber } from '../../../shared/types/station';
import { isSameStationName } from '../../../shared/utils/stationRoute';
import type { AnchorDeparturesView, AnchorDepartureWireRow } from '../api/anchorDepartures';

export interface DepartedTrainRow {
  train: ArrivalInfo;
  departedAtMs: number;
  currentStation: string | null;
}

function toRow(wire: AnchorDepartureWireRow, line: LineNumber): DepartedTrainRow {
  const { trainCode, departedAt, currentStation } = wire;
  return {
    train: {
      destination: '',
      arrivalSeconds: null,
      stopsAway: null,
      statusMessage: '',
      trainCode,
      line,
      receivedAtMs: departedAt,
      arrivalCode: ARRIVAL_CODE.DEPARTED,
      isLastTrain: false,
      trainType: 'normal',
    },
    departedAtMs: departedAt,
    currentStation,
  };
}

/**
 * 이 목록(역 + 노선)에 속한 출발 열차만 최근 출발 순으로. backend 앵커와 다른 슬롯(예: 환승 슬롯 vs 출발
 * 슬롯)에는 보여 주지 않고, 오래된 캐시가 남아도 10분을 넘긴 행은 device에서도 한 번 더 거른다.
 */
export function buildDepartedTrainRows(
  view: AnchorDeparturesView | null,
  slot: { stationName: string; line: LineNumber },
  nowMs: number,
): DepartedTrainRow[] {
  if (view === null) return [];
  if (view.line !== slot.line || !isSameStationName(view.station, slot.stationName)) return [];
  return view.departed
    .filter(({ departedAt }) => nowMs - departedAt <= DEPARTED_TRAIN_WINDOW_MS)
    .map((wire) => toRow(wire, slot.line))
    .sort((a, b) => b.departedAtMs - a.departedAtMs);
}
