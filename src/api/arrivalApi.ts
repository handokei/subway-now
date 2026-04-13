export interface ArrivalInfo {
  destination: string;
  arrivalMinutes: number;
  trainCode: string;
}

export interface StationArrival {
  up: ArrivalInfo[];
  down: ArrivalInfo[];
  isMock?: boolean;
}

export const MOCK_ARRIVALS: Readonly<StationArrival> = Object.freeze({
  up: [
    { destination: '상행 종착역', arrivalMinutes: 2, trainCode: 'UP-001' },
    { destination: '상행 종착역', arrivalMinutes: 8, trainCode: 'UP-002' },
  ],
  down: [
    { destination: '하행 종착역', arrivalMinutes: 4, trainCode: 'DN-001' },
    { destination: '하행 종착역', arrivalMinutes: 11, trainCode: 'DN-002' },
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
    // API 키 없을 때 Mock 데이터 반환
    return MOCK_ARRIVALS;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `https://swopenapi.seoul.go.kr/api/subway/${apiKey}/json/realtimeStationArrival/0/10/${encodeURIComponent(stationName)}`;

    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      return MOCK_ARRIVALS;
    }

    const data = await response.json();
    const items: any[] = data.realtimeArrivalList ?? [];

    const up: ArrivalInfo[] = [];
    const down: ArrivalInfo[] = [];

    for (const item of items) {
      const info: ArrivalInfo = {
        destination: item.trainLineNm ?? '',
        arrivalMinutes: Math.max(0, Math.floor((item.barvlDt ?? 0) / 60)),
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
      return MOCK_ARRIVALS;
    }
    return sliced;
  } catch {
    return MOCK_ARRIVALS;
  } finally {
    clearTimeout(timeout);
  }
}
