import i18next from 'i18next';
import type { Station } from '../types/station';

// 역명을 현재 i18next 언어에 맞춰 표시한다.
// - 한국어(`ko`): 한글 그대로 (플랫폼 안내판과 일치)
// - 그 외(en/ja/zh 등): `nameEn` (영문 표기) — 라틴 알파벳이 비한국어권 사용자에게 가장 보편적.
//   `nameJa`/`nameZh` 데이터 도입은 528개 역 × N언어 비용이 매우 커서 별도 트랙.
// nameEn 누락 시에는 한글로 fallback.
export function getStationDisplayName(station: Pick<Station, 'name' | 'nameEn'>): string {
  if (i18next.language !== 'ko' && station.nameEn) {
    return station.nameEn;
  }
  return station.name;
}

// stationName(한글)만 가진 위치에서 사용. 알람/알림 빌더처럼 Station 객체가 아닌 문자열만 들고
// 있는 경우, name → nameEn 매핑을 위해 stations 데이터에서 lookup.
export function getStationDisplayNameByName(name: string, stations: readonly Station[]): string {
  if (i18next.language === 'ko') return name;
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
