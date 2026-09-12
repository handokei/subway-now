import stationCodesData from '../../data/stationCodes.json';

/**
 * `stations.json` id (`${line}-${seq}` 형식) → 서울교통공사 OpenAPI `STATION_CD`/`FR_CODE` 매핑.
 *
 * - `STATION_CD` (4자리): 전철역코드 — `SearchSTNTimeTableByIDService` 등 ID 기반 endpoint 인자.
 * - `FR_CODE` (외부코드): 환승역/협력사 호환 외부코드 — `SearchSTNTimeTableByFRCodeService` 인자.
 *
 * SSOT: `src/data/stationCodes.json` (ingest script: `scripts/fetch-station-codes-and-times.js`).
 * 1~9호선은 100% 매핑이 목표. 외부 노선(분당/신분당/경의중앙 등)은 best-effort.
 * 매핑 부재 시 `null` 반환 — 호출자는 fallback(역명 기반 endpoint 등) 처리 책임.
 */
type StationCodeEntry = { stationCd: string; frCode: string };

const stationCodes = stationCodesData as Record<string, StationCodeEntry>;

export function getStationCode(stationsJsonId: string): StationCodeEntry | null {
  return stationCodes[stationsJsonId] ?? null;
}
