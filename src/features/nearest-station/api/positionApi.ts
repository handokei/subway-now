import { createLogger } from '../../../shared/utils/logger';
import { parseTrainTypeFromDirectAt } from '../../../shared/constants/trainTypes';
import { getLineApiName } from '../../../shared/constants/lineApiNames';
import { fromSeoulStationName } from '../../../shared/constants/seoulStationNameMap';
import type { LineNumber } from '../../../shared/types/station';
import type { TrainPosition, LinePositions } from '../../../shared/types/position';

// 도메인 type은 shared/types/position으로 추출됨 (#890, Phase 5).
// 기존 호출자 호환을 위해 re-export 유지.
export type { TrainPosition, LinePositions };

const log = createLogger('positionApi');

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
 * #2868 — `realtimePosition`의 `statnNm`은 종착/지선 진입 열차에 역명 아닌 상태 문자열을
 * 담는다(backend parsePositionEntry와 동일 실측 근거: 열차 3174 statnNm='성수종착',
 * '성수지선'도 R2 캡처 어휘에 존재). 접미 strip으로 역명을 복원 — strip 결과가 빈 문자열이
 * 되는 경우(접미 자체가 전체 문자열)는 원문을 보존한다.
 */
const POSITION_STATION_SENTINEL_SUFFIXES = ['종착', '지선'] as const;

function stripPositionStationSentinel(statnNm: string): string {
  for (const suffix of POSITION_STATION_SENTINEL_SUFFIXES) {
    if (statnNm.endsWith(suffix) && statnNm.length > suffix.length) {
      return statnNm.slice(0, -suffix.length);
    }
  }
  return statnNm;
}

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

// FetchPositionOptions는 shared/types/providers로 추출됨 (#890, Phase 5).
import type { FetchPositionOptions } from '../../../shared/types/providers';
export type { FetchPositionOptions };

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
        // #2868 — ①종착/지선 sentinel strip ②Seoul 응답명→stations.json명 역매핑. 번역은
        // 이 경계에서만 — pickCandidateTrains/useFusedNearestStation 등 소비자는 무변경.
        statnNm: fromSeoulStationName(stripPositionStationSentinel(String(item.statnNm ?? ''))),
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
