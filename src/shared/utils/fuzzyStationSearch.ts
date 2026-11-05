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

function decomposeToJamo(text: string): string {
  return [...text].map(charToJamo).join('');
}

// 키스트로크마다 528역을 재분해하지 않도록 역 객체 → 자모 캐시. WeakMap이라 역 객체가
// GC되면 엔트리도 함께 사라진다(전역 무한 성장 없음).
const jamoCache = new WeakMap<SearchableStation, string>();
function stationJamo(station: SearchableStation): string {
  const cached = jamoCache.get(station);
  if (cached !== undefined) return cached;
  const jamo = decomposeToJamo(normalizeStationName(station.name));
  jamoCache.set(station, jamo);
  return jamo;
}

// 쿼리(a)와 역명 자모(b)의 "prefix-tolerant" Levenshtein: b의 어떤 prefix와도 가장 가까운
// 거리(DP 마지막 행의 최솟값)를 구한다. 입력 중인 부분 문자열의 오타도 완성 전에 잡기 위함.
// maxEdits 초과가 확정되면 maxEdits + 1을 반환한다.
function prefixEditDistance(a: string, b: string, maxEdits: number): number {
  if (a.length - b.length > maxEdits) return maxEdits + 1;
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
  return Math.min(...prev);
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

  // 저비용 단계(①②)를 먼저 전수 수집 — limit을 채우면 비싼 자모 비교(③④)는 건너뛴다.
  const rest: T[] = [];
  for (const station of stations) {
    if (isPrefixMatch(station, query, queryLower)) exact.push(station);
    else if (matchesStationQuery(station, query, queryLower)) substring.push(station);
    else rest.push(station);
  }
  if (!fuzzyEnabled || exact.length + substring.length >= limit) {
    return [...exact, ...substring].slice(0, limit);
  }

  for (const station of rest) {
    const jamo = stationJamo(station);
    if (jamo.startsWith(queryJamo)) {
      jamoPrefix.push(station);
    } else {
      const distance = prefixEditDistance(queryJamo, jamo, maxEdits);
      if (distance <= maxEdits) fuzzy.push({ station, distance });
    }
  }

  fuzzy.sort((x, y) => x.distance - y.distance);
  return [...exact, ...substring, ...jamoPrefix, ...fuzzy.map((f) => f.station)].slice(0, limit);
}
