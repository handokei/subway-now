/**
 * 서울 열린데이터 API `realtimeStationArrival.btrainSttus` 응답값 → 표준 타입 매핑.
 * 스펙: scripts/서울시+지하철+실시간+도착정보.xls (열차종류: 급행, ITX, 일반, 특급)
 */
export type TrainType = 'express' | 'itx' | 'rapid' | 'normal';

const BTRAIN_STTUS_TO_TYPE: Record<string, TrainType> = {
  급행: 'express',
  ITX: 'itx',
  특급: 'rapid',
};

export function parseTrainType(btrainSttus: unknown): TrainType {
  if (typeof btrainSttus !== 'string') return 'normal';
  return BTRAIN_STTUS_TO_TYPE[btrainSttus.trim()] ?? 'normal';
}

/** UI 라벨. 데이터 주도 — 새 타입 추가 시 한 줄 변경. */
export const TRAIN_TYPE_LABEL: Record<TrainType, string> = {
  express: '급행',
  itx: 'ITX',
  rapid: '특급',
  normal: '',
};
