import { createLogger } from '../utils/logger';

const log = createLogger('arrivalApi');

export interface ArrivalInfo {
  destination: string;
  arrivalMinutes: number;
  arrivalSeconds: number;
  statusMessage: string;
  trainCode: string;
}

export interface StationArrival {
  up: ArrivalInfo[];
  down: ArrivalInfo[];
  isMock?: boolean;
}

export const MOCK_ARRIVALS: Readonly<StationArrival> = Object.freeze({
  up: [
    { destination: '상행 종착역', arrivalMinutes: 2, arrivalSeconds: 120, statusMessage: '', trainCode: 'UP-001' },
    { destination: '상행 종착역', arrivalMinutes: 8, arrivalSeconds: 480, statusMessage: '', trainCode: 'UP-002' },
  ],
  down: [
    { destination: '하행 종착역', arrivalMinutes: 4, arrivalSeconds: 240, statusMessage: '', trainCode: 'DN-001' },
    { destination: '하행 종착역', arrivalMinutes: 11, arrivalSeconds: 660, statusMessage: '', trainCode: 'DN-002' },
  ],
  isMock: true,
});

export interface FetchArrivalOptions {
  timeoutMs?: number;
  maxPerDirection?: number;
}

export async function fetchArrivalInfo(
  stationName: string,
  options?: FetchArrivalOptions,
): Promise<StationArrival> {
  const { timeoutMs = 5000, maxPerDirection = 2 } = options ?? {};
  const apiKey = process.env.EXPO_PUBLIC_SEOUL_DATA_API_KEY;

  if (!apiKey) {
    log.warn('API key not set (EXPO_PUBLIC_SEOUL_DATA_API_KEY)');
    return MOCK_ARRIVALS;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `http://swopenapi.seoul.go.kr/api/subway/${apiKey}/json/realtimeStationArrival/0/10/${encodeURIComponent(stationName)}`;

    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      log.warn(`HTTP ${response.status} for station "${stationName}"`);
      return MOCK_ARRIVALS;
    }

    const data = await response.json();
    const items: any[] = data.realtimeArrivalList ?? [];

    const up: ArrivalInfo[] = [];
    const down: ArrivalInfo[] = [];

    for (const item of items) {
      const seconds = Math.max(0, item.barvlDt ?? 0);
      const info: ArrivalInfo = {
        destination: item.trainLineNm ?? '',
        arrivalMinutes: Math.floor(seconds / 60),
        arrivalSeconds: seconds,
        statusMessage: item.arvlMsg2 ?? '',
        trainCode: item.btrainNo ?? '',
      };
      if (item.updnLine === '상행' || item.updnLine === '내선') {
        up.push(info);
      } else {
        down.push(info);
      }
    }

    const sliced = { up: up.slice(0, maxPerDirection), down: down.slice(0, maxPerDirection) };
    if (sliced.up.length === 0 && sliced.down.length === 0) {
      log.warn(`No arrivals for station "${stationName}"`);
      return MOCK_ARRIVALS;
    }
    return sliced;
  } catch (e) {
    log.error(`Fetch failed for station "${stationName}":`, e);
    return MOCK_ARRIVALS;
  } finally {
    clearTimeout(timeout);
  }
}
