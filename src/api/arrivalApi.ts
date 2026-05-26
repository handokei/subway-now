import { createLogger } from '../utils/logger';
import { parseTrainType, type TrainType } from '../constants/trainTypes';
import { findLineByStationName } from '../utils/stationLookup';
import { buildScheduleArrival, hasHeadwayData } from '../utils/scheduleFallback';
import type { LineNumber } from '../types/station';

const log = createLogger('arrivalApi');

export interface ArrivalInfo {
  destination: string;
  arrivalMinutes: number;
  arrivalSeconds: number;
  statusMessage: string;
  trainCode: string;
  /** 데이터 생성 시각(epoch ms). 0이면 알 수 없음(mock 또는 누락). Stage 2 fusion 신호 신선도 판정용. */
  receivedAtMs: number;
  /**
   * arvlCd 응답값 — 0:진입, 1:도착, 2:출발, 3:전역출발, 4:전역진입, 5:전역도착, 99:운행중.
   * 누락/비숫자는 -1. fusion 우선순위 판정에 사용 (constants/arrivalCodes.ts).
   */
  arrivalCode: number;
  /** lstcarAt === '1'이면 막차. 사용자 안전성 표시용. */
  isLastTrain: boolean;
  /** btrainSttus 매핑. 'normal'은 라벨 빈 문자열로 배지 미표시. */
  trainType: TrainType;
}

export type ArrivalSource = 'realtime' | 'schedule' | 'closed';

export interface StationArrival {
  up: ArrivalInfo[];
  down: ArrivalInfo[];
  isMock?: boolean;
  /** 데이터 출처. UI 라벨 분기(시간표 기준 / 운행 종료)에 사용. */
  source?: ArrivalSource;
}

export const MOCK_ARRIVALS: Readonly<StationArrival> = Object.freeze({
  up: [
    { destination: '상행 종착역', arrivalMinutes: 2, arrivalSeconds: 120, statusMessage: '', trainCode: 'UP-001', receivedAtMs: 0, arrivalCode: -1, isLastTrain: false, trainType: 'normal' as const },
    { destination: '상행 종착역', arrivalMinutes: 8, arrivalSeconds: 480, statusMessage: '', trainCode: 'UP-002', receivedAtMs: 0, arrivalCode: -1, isLastTrain: false, trainType: 'normal' as const },
  ],
  down: [
    { destination: '하행 종착역', arrivalMinutes: 4, arrivalSeconds: 240, statusMessage: '', trainCode: 'DN-001', receivedAtMs: 0, arrivalCode: -1, isLastTrain: false, trainType: 'normal' as const },
    { destination: '하행 종착역', arrivalMinutes: 11, arrivalSeconds: 660, statusMessage: '', trainCode: 'DN-002', receivedAtMs: 0, arrivalCode: -1, isLastTrain: false, trainType: 'normal' as const },
  ],
  isMock: true,
});

/** 서울 열린데이터 API updnLine 응답값 — 상행/내선이면 up 방향 */
const UP_DIRECTION_VALUES = ['상행', '내선'] as const;

/** 서울 열린데이터 API recptnDt 타임존(KST 고정). */
const SEOUL_API_TZ_OFFSET = '+09:00';

/** recptnDt가 너무 오래된 경우 보정량이 비현실적이므로 stale로 강등한다. */
const MAX_RECPTN_DRIFT_SEC = 120;

/**
 * recptnDt("YYYY-MM-DD HH:mm:ss", KST)를 epoch ms로 변환한다.
 * 파싱 실패/누락 시 0(=알 수 없음)을 반환한다.
 */
export function parseRecptnDt(recptnDt: unknown): number {
  if (typeof recptnDt !== 'string' || recptnDt.length === 0) return 0;
  const ms = Date.parse(recptnDt.replace(' ', 'T') + SEOUL_API_TZ_OFFSET);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * 실시간 API 실패 시 시간표 기반 fallback을 만든다.
 * 역명으로 호선을 찾지 못하면(드문 케이스) 최후 수단으로 하드코딩 MOCK_ARRIVALS 반환.
 * fallback 발생은 항상 로깅한다 — 후속 Option B(시간표 ETL) 필요성을 데이터로 판단하기 위함.
 */
/**
 * 실시간 응답을 얻지 못한 caller가 schedule fallback을 동일한 정책으로 사용하기 위한 진입점.
 * (SeoulOpenApiProvider 외에 BffArrivalProvider도 공유 — provider 간 fallback 정책 일관성.)
 */
export function getFallbackArrival(
  stationName: string,
  reason: string,
  lineHint?: LineNumber,
): StationArrival {
  // lineHint가 있으면 환승역에서 정확한 호선의 schedule을 사용. 없으면 역명으로 lookup.
  const line = lineHint ?? findLineByStationName(stationName);
  if (!line || !hasHeadwayData(line)) {
    log.warn('schedule_fallback_unavailable', { station: stationName, line, reason });
    return MOCK_ARRIVALS;
  }
  const result = buildScheduleArrival(line, stationName, new Date());
  log.info('schedule_fallback_fired', {
    station: stationName,
    line,
    reason,
    source: result.source,
    fromHint: lineHint != null,
  });
  return result;
}

export interface FetchArrivalOptions {
  timeoutMs?: number;
  maxPerDirection?: number;
  lineHint?: LineNumber;
}

export async function fetchArrivalInfo(
  stationName: string,
  options?: FetchArrivalOptions,
): Promise<StationArrival> {
  const { timeoutMs = 5000, maxPerDirection = 2, lineHint } = options ?? {};
  const apiKey = process.env.EXPO_PUBLIC_SEOUL_DATA_API_KEY;

  if (!apiKey) {
    log.warn('API key not set (EXPO_PUBLIC_SEOUL_DATA_API_KEY)');
    return getFallbackArrival(stationName, 'no_api_key', lineHint);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `http://swopenapi.seoul.go.kr/api/subway/${apiKey}/json/realtimeStationArrival/0/10/${encodeURIComponent(stationName)}`;

    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      log.warn(`HTTP ${response.status} for station "${stationName}"`);
      return getFallbackArrival(stationName, `http_${response.status}`, lineHint);
    }

    const data = await response.json();
    const items: any[] = data.realtimeArrivalList ?? [];

    const up: ArrivalInfo[] = [];
    const down: ArrivalInfo[] = [];

    const now = Date.now();
    for (const item of items) {
      const rawSeconds = Math.max(0, item.barvlDt ?? 0);
      // recptnDt(데이터 생성시각)와 현재시각의 차이만큼 열차가 더 진행한 것으로 보정.
      // xls 스펙 주의사항에 명시된 처리. recptnDt 누락 또는 비정상 drift는 stale로 강등.
      const parsedRecvMs = parseRecptnDt(item.recptnDt);
      const rawDriftSec = parsedRecvMs > 0 ? (now - parsedRecvMs) / 1000 : 0;
      const isStale = parsedRecvMs > 0 && rawDriftSec > MAX_RECPTN_DRIFT_SEC;
      const receivedAtMs = isStale ? 0 : parsedRecvMs;
      const driftSec = isStale ? 0 : Math.max(0, rawDriftSec);
      const seconds = Math.max(0, Math.round(rawSeconds - driftSec));
      const parsedCode =
        typeof item.arvlCd === 'number'
          ? item.arvlCd
          : typeof item.arvlCd === 'string'
            ? Number.parseInt(item.arvlCd, 10)
            : NaN;
      const info: ArrivalInfo = {
        destination: item.trainLineNm ?? '',
        arrivalMinutes: Math.floor(seconds / 60),
        arrivalSeconds: seconds,
        statusMessage: item.arvlMsg2 ?? '',
        trainCode: item.btrainNo ?? '',
        receivedAtMs,
        arrivalCode: Number.isFinite(parsedCode) ? parsedCode : -1,
        isLastTrain: item.lstcarAt === '1' || item.lstcarAt === 1,
        trainType: parseTrainType(item.btrainSttus),
      };
      if (UP_DIRECTION_VALUES.includes(item.updnLine)) {
        up.push(info);
      } else {
        down.push(info);
      }
    }

    const sliced: StationArrival = {
      up: up.slice(0, maxPerDirection),
      down: down.slice(0, maxPerDirection),
      source: 'realtime',
    };
    if (sliced.up.length === 0 && sliced.down.length === 0) {
      log.warn(`No arrivals for station "${stationName}"`);
      return getFallbackArrival(stationName, 'empty_response', lineHint);
    }
    return sliced;
  } catch (e) {
    log.error(`Fetch failed for station "${stationName}":`, e);
    return getFallbackArrival(stationName, 'fetch_error', lineHint);
  } finally {
    clearTimeout(timeout);
  }
}
