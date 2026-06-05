import i18next from 'i18next';

import type { SupportedLanguage } from '../shared/i18n/types';
import type { Station } from '../types/station';

type StationLabelFields = Pick<Station, 'name' | 'nameEn' | 'nameJa' | 'nameHanja'>;

// 언어별 표시 우선순위. 빈 배열이면 곧장 한글 `name`을 쓴다(한국어 기본).
// 그 외 언어는 자국 표기 → 영문(`nameEn`) 순으로 시도하고, 모두 누락이면 마지막에 한글로
// 떨어진다(실운영에선 영문이 528/528이라 거의 발생하지 않음). 새 언어 추가 시 한 줄만 추가.
const PRIORITY_BY_LANGUAGE = {
  ko: [],
  en: ['nameEn'],
  ja: ['nameJa', 'nameEn'],
  zh: ['nameHanja', 'nameEn'],
} as const satisfies Record<SupportedLanguage, ReadonlyArray<keyof StationLabelFields>>;

function pickLabel(station: StationLabelFields, lang: SupportedLanguage): string {
  for (const field of PRIORITY_BY_LANGUAGE[lang]) {
    const value = station[field];
    if (value) return value;
  }
  return station.name;
}

function currentLanguage(): SupportedLanguage {
  const lang = i18next.language as SupportedLanguage;
  return lang in PRIORITY_BY_LANGUAGE ? lang : 'en';
}

// 역명을 현재 i18next 언어에 맞춰 표시한다. 우선순위는 PRIORITY_BY_LANGUAGE 참조.
export function getStationDisplayName(station: StationLabelFields): string {
  return pickLabel(station, currentLanguage());
}

// stationName(한글)만 가진 위치에서 사용. 알람/알림 빌더처럼 Station 객체가 아닌 문자열만 들고
// 있는 경우, name → 다국어 매핑을 위해 stations 데이터에서 lookup.
export function getStationDisplayNameByName(name: string, stations: readonly Station[]): string {
  const lang = currentLanguage();
  if (lang === 'ko') return name;
  const found = stations.find((s) => s.name === name);
  return found ? pickLabel(found, lang) : name;
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
