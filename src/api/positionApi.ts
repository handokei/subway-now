import { createLogger } from '../utils/logger';
import { parseTrainTypeFromDirectAt, type TrainType } from '../constants/trainTypes';
import { getLineApiName } from '../constants/lineApiNames';
import type { LineNumber } from '../types/station';

const log = createLogger('positionApi');

/**
 * realtimePosition 응답의 단일 열차 정보(앱 도메인 형태로 정규화).
 * statnId가 fusion 신호의 핵심 — "이 열차가 지금 어느 역에 있나" 확정 정보.
 */
export interface TrainPosition {
  statnId: string;
  statnNm: string;
  trainNo: string;
  /** trainSttus: 0:진입, 1:도착, 2:출발, 3:전역출발 */
  trainStatus: number;
  /** 0:상행/내선, 1:하행/외선 */
  updnLine: number;
  /** 종착역 */
  terminalStationId: string;
  terminalStationName: string;
  /** directAt 매핑(express/rapid/normal — ITX는 도착정보에서만) */
  trainType: TrainType;
  isLastTrain: boolean;
  /** recptnDt 파싱 결과 — Stage 1과 같은 신선도 계약(0=알 수 없음). */
  receivedAtMs: number;
}

export interface LinePositions {
  line: LineNumber;
  trains: TrainPosition[];
  isMock?: boolean;
}

/** mock — API 키 없거나 실패 시 fallback. fusion 신호로 사용되지 않음(receivedAtMs=0). */
export const MOCK_POSITIONS: Readonly<LinePositions> = Object.freeze({
  line: '2' as LineNumber,
  trains: [],
  isMock: true,
});

/** 서울 열린데이터 API recptnDt 타임존(KST). arrivalApi와 동일 정책. */
const SEOUL_API_TZ_OFFSET = '+09:00';
/** drift 상한(s) — 비정상이면 stale로 강등. arrivalApi와 동일 정책. */
const MAX_RECPTN_DRIFT_SEC = 120;

/** "YYYY-MM-DD[ T]HH:mm:ss" 풀 포맷 판정 — 인식 못하는 입력은 0(알 수 없음)으로 강등한다. */
const FULL_DATETIME_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/;
/** "HH:mm:ss" 시각 단독 — lastRecptnDt(날짜)와 합쳐 풀 포맷 구성. */
const TIME_ONLY_RE = /^\d{2}:\d{2}:\d{2}/;

/**
 * realtimePosition은 lastRecptnDt(날짜)와 recptnDt(시각)를 분리해서 보낼 수 있다.
 * 명세에 정확한 형식이 명시되지 않아 두 케이스 모두 대응:
 *   - recptnDt가 "YYYY-MM-DD HH:mm:ss" 풀 포맷이면 그대로 파싱
 *   - "HH:mm:ss"만 오면 lastRecptnDt와 합쳐 파싱
 * 알 수 없는 포맷이면 0(=stale로 강등 — fusion에서 무시됨).
 */
export function parsePositionRecvTime(lastRecptnDt: unknown, recptnDt: unknown): number {
  const recv = typeof recptnDt === 'string' ? recptnDt.trim() : '';
  const date = typeof lastRecptnDt === 'string' ? lastRecptnDt.trim() : '';
  if (!recv) return 0;
  let full: string;
  if (FULL_DATETIME_RE.test(recv)) {
    full = recv;
  } else if (TIME_ONLY_RE.test(recv) && date) {
    full = `${date} ${recv}`;
  } else {
    return 0;
  }
  // 정규식 통과 후 Date.parse가 NaN이어도 호출자(parsedRecvMs > 0 검사)에서 자연스럽게 stale 강등.
  return Date.parse(full.replace(' ', 'T') + SEOUL_API_TZ_OFFSET);
}

export interface FetchPositionOptions {
  timeoutMs?: number;
  /** 0~limit 범위로 호출 (호선당 최대 1000건이지만 일반적으로 100 충분). */
  limit?: number;
}

export async function fetchTrainPositions(
  line: LineNumber,
  options?: FetchPositionOptions,
): Promise<LinePositions> {
  const { timeoutMs = 5000, limit = 100 } = options ?? {};
  const apiKey = process.env.EXPO_PUBLIC_SEOUL_DATA_API_KEY;

  if (!apiKey) {
    log.warn('API key not set (EXPO_PUBLIC_SEOUL_DATA_API_KEY)');
    return { ...MOCK_POSITIONS, line };
  }

  const apiName = getLineApiName(line);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `http://swopenapi.seoul.go.kr/api/subway/${apiKey}/json/realtimePosition/0/${limit}/${encodeURIComponent(apiName)}`;
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      log.warn(`HTTP ${response.status} for line "${apiName}"`);
      return { ...MOCK_POSITIONS, line };
    }

    const data = await response.json();
    const items: any[] = data.realtimePositionList ?? [];

    const now = Date.now();
    const trains: TrainPosition[] = items.map((item) => {
      const parsedRecvMs = parsePositionRecvTime(item.lastRecptnDt, item.recptnDt);
      const driftSec = parsedRecvMs > 0 ? (now - parsedRecvMs) / 1000 : 0;
      const isStale = parsedRecvMs > 0 && driftSec > MAX_RECPTN_DRIFT_SEC;
      const receivedAtMs = isStale ? 0 : parsedRecvMs;

      const parsedStatus =
        typeof item.trainSttus === 'number'
          ? item.trainSttus
          : typeof item.trainSttus === 'string'
            ? Number.parseInt(item.trainSttus, 10)
            : NaN;
      const parsedUpdn =
        typeof item.updnLine === 'number'
          ? item.updnLine
          : typeof item.updnLine === 'string'
            ? Number.parseInt(item.updnLine, 10)
            : NaN;

      return {
        statnId: String(item.statnId ?? ''),
        statnNm: String(item.statnNm ?? ''),
        trainNo: String(item.trainNo ?? ''),
        trainStatus: Number.isFinite(parsedStatus) ? parsedStatus : -1,
        updnLine: Number.isFinite(parsedUpdn) ? parsedUpdn : -1,
        terminalStationId: String(item.statnTid ?? ''),
        terminalStationName: String(item.statnTnm ?? ''),
        trainType: parseTrainTypeFromDirectAt(item.directAt),
        isLastTrain: item.lstcarAt === '1' || item.lstcarAt === 1,
        receivedAtMs,
      };
    });

    if (trains.length === 0) {
      log.warn(`No trains for line "${apiName}"`);
      return { ...MOCK_POSITIONS, line };
    }
    return { line, trains };
  } catch (e) {
    log.error(`Fetch failed for line "${apiName}":`, e);
    return { ...MOCK_POSITIONS, line };
  } finally {
    clearTimeout(timeout);
  }
}
