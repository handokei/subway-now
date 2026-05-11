import i18next from 'i18next';
import type { Station } from '../types/station';

// 역명을 현재 i18next 언어에 맞춰 표시한다.
// - 영문 모드(`en`) + nameEn 존재 → 영문
// - 그 외 → 한글 (nameEn 누락 시에도 한글로 fallback)
export function getStationDisplayName(station: Pick<Station, 'name' | 'nameEn'>): string {
  if (i18next.language === 'en' && station.nameEn) {
    return station.nameEn;
  }
  return station.name;
}

// stationName(한글)만 가진 위치에서 사용. 알람/알림 빌더처럼 Station 객체가 아닌 문자열만 들고
// 있는 경우, name → nameEn 매핑을 위해 stations 데이터에서 lookup.
export function getStationDisplayNameByName(name: string, stations: readonly Station[]): string {
  if (i18next.language !== 'en') return name;
  const found = stations.find((s) => s.name === name);
  return found?.nameEn ?? name;
}

// 검색어가 역의 한글명 또는 영문명(대소문자 무관)과 부분 일치하는지 검사한다.
// queryLower는 caller가 미리 toLowerCase한 값. 한글 부분은 원본 쿼리로 비교.
export function matchesStationQuery(
  station: Pick<Station, 'name' | 'nameEn'>,
  query: string,
  queryLower: string,
): boolean {
  if (station.name.includes(query)) return true;
  if (!station.nameEn) return false;
  return station.nameEn.toLowerCase().includes(queryLower);
}
