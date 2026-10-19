import {
  CHOSEONG,
  FUZZY_JAMO_PER_EDIT,
  HANGUL_JONG_COUNT,
  HANGUL_JUNG_COUNT,
  HANGUL_PATTERN,
  HANGUL_SYLLABLE_BASE,
  HANGUL_SYLLABLE_LAST,
  JAMO_EXPANSION,
  JONGSEONG,
  JUNGSEONG,
} from '../constants/hangulJamo';
import type { Station } from '../types/station';
import { normalizeStationName } from './normalizeStationName';
import { matchesStationQuery } from './stationDisplay';

type SearchableStation = Pick<Station, 'name' | 'nameEn'>;

// 한글 음절/호환 자모/그 외 문자를 자모 시퀀스(복합 모음·겹받침 풀어쓰기)로 평탄화한다.
function charToJamo(ch: string): string {
  const code = ch.charCodeAt(0);
  if (code < HANGUL_SYLLABLE_BASE || code > HANGUL_SYLLABLE_LAST) {
    return JAMO_EXPANSION[ch] ?? ch;
  }
  const offset = code - HANGUL_SYLLABLE_BASE;
  const jong = offset % HANGUL_JONG_COUNT;
  const jung = Math.floor(offset / HANGUL_JONG_COUNT) % HANGUL_JUNG_COUNT;
  const cho = Math.floor(offset / (HANGUL_JONG_COUNT * HANGUL_JUNG_COUNT));
  const parts = [CHOSEONG[cho], JUNGSEONG[jung], JONGSEONG[jong]];
  return parts.map((p) => JAMO_EXPANSION[p] ?? p).join('');
}

export function decomposeToJamo(text: string): string {
  return [...text].map(charToJamo).join('');
}

// 키스트로크마다 528역을 재분해하지 않도록 정규화 역명 → 자모 캐시 (역명 집합은 고정).
const jamoCache = new Map<string, string>();
function stationJamo(name: string): string {
  const cached = jamoCache.get(name);
  if (cached !== undefined) return cached;
  const jamo = decomposeToJamo(normalizeStationName(name));
  jamoCache.set(name, jamo);
  return jamo;
}

// maxEdits 초과가 확정되면 maxEdits + 1을 반환하는 Levenshtein.
function boundedEditDistance(a: string, b: string, maxEdits: number): number {
  if (Math.abs(a.length - b.length) > maxEdits) return maxEdits + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const curr = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      curr.push(value);
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > maxEdits) return maxEdits + 1;
    prev = curr;
  }
  return prev[b.length];
}

function isPrefixMatch(station: SearchableStation, query: string, queryLower: string): boolean {
  if (station.name.startsWith(query)) return true;
  return station.nameEn?.toLowerCase().startsWith(queryLower) ?? false;
}

/**
 * 역 검색 랭킹 (퍼지 포함). 같은 단계 안에서는 입력 순서를 유지한다.
 *  ① 정확/전방일치 → ② 부분문자열 → ③ 자모 prefix(IME 조합 중) → ④ 자모 편집거리(길이비례 임계)
 * ③④는 한글 쿼리에만 적용하고, 기존 ①② 결과 집합·순서 의미는 그대로 앞에 둔다.
 */
export function searchStations<T extends SearchableStation>(
  stations: readonly T[],
  rawQuery: string,
  limit: number,
): T[] {
  const query = rawQuery.trim();
  if (!query) return [];
  const queryLower = query.toLowerCase();
  const exact: T[] = [];
  const substring: T[] = [];
  const jamoPrefix: T[] = [];
  const fuzzy: { station: T; distance: number }[] = [];

  const fuzzyEnabled = HANGUL_PATTERN.test(query);
  const queryJamo = fuzzyEnabled ? decomposeToJamo(normalizeStationName(query.replace(/\s+/g, ''))) : '';
  const maxEdits = Math.floor(queryJamo.length / FUZZY_JAMO_PER_EDIT);

  for (const station of stations) {
    if (isPrefixMatch(station, query, queryLower)) {
      exact.push(station);
    } else if (matchesStationQuery(station, query, queryLower)) {
      substring.push(station);
    } else if (fuzzyEnabled) {
      const jamo = stationJamo(station.name);
      if (jamo.startsWith(queryJamo)) {
        jamoPrefix.push(station);
      } else {
        const distance = boundedEditDistance(queryJamo, jamo, maxEdits);
        if (distance <= maxEdits) fuzzy.push({ station, distance });
      }
    }
  }

  fuzzy.sort((x, y) => x.distance - y.distance);
  return [...exact, ...substring, ...jamoPrefix, ...fuzzy.map((f) => f.station)].slice(0, limit);
}
