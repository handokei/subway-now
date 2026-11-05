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

/**
 * 배지 시각 variant. 급행/특급/ITX는 사용자가 잘못된 열차에 타지 않도록
 * 안전성 직결 정보 → filled로 가장 두드러지게 표시한다.
 * normal은 라벨 자체가 없어 사용되지 않는다.
 */
export type BadgeVariant = 'filled' | 'outline';

export const TRAIN_TYPE_VARIANT: Record<TrainType, BadgeVariant> = {
  express: 'filled',
  itx: 'filled',
  rapid: 'filled',
  normal: 'outline',
};

/**
 * realtimePosition API의 `directAt` 응답값(숫자) → 같은 TrainType enum으로 통합.
 * 스펙: 1:급행, 0:아님, 7:특급 (ITX는 directAt에 없음 — btrainSttus 텍스트로만 옴)
 */
const DIRECT_AT_TO_TYPE: Record<number, TrainType> = {
  1: 'express',
  7: 'rapid',
};

export function parseTrainTypeFromDirectAt(directAt: unknown): TrainType {
  const n =
    typeof directAt === 'number'
      ? directAt
      : typeof directAt === 'string'
        ? Number.parseInt(directAt, 10)
        : NaN;
  if (!Number.isFinite(n)) return 'normal';
  return DIRECT_AT_TO_TYPE[n] ?? 'normal';
}
