export interface ArrivalInfo {
  destination: string;
  arrivalMinutes: number;
  trainCode: string;
}

export interface StationArrival {
  up: ArrivalInfo[];
  down: ArrivalInfo[];
}

const MOCK_ARRIVALS: StationArrival = {
  up: [
    { destination: '상행 종착역', arrivalMinutes: 2, trainCode: 'UP-001' },
    { destination: '상행 종착역', arrivalMinutes: 8, trainCode: 'UP-002' },
  ],
  down: [
    { destination: '하행 종착역', arrivalMinutes: 4, trainCode: 'DN-001' },
    { destination: '하행 종착역', arrivalMinutes: 11, trainCode: 'DN-002' },
  ],
};

export async function fetchArrivalInfo(stationName: string): Promise<StationArrival> {
  const apiKey = process.env.EXPO_PUBLIC_SEOUL_DATA_API_KEY;

  if (!apiKey) {
    // API 키 없을 때 Mock 데이터 반환
    return MOCK_ARRIVALS;
  }

  const url = `http://swopenapi.seoul.go.kr/api/subway/${apiKey}/json/realtimeStationArrival/0/10/${encodeURIComponent(stationName)}`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`도착 정보 API 오류: ${response.status}`);
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

  return { up: up.slice(0, 2), down: down.slice(0, 2) };
}
