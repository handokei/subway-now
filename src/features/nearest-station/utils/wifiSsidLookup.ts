/**
 * Wifi SSID 직접 매칭으로 역을 확정한다 (#913, Epic #912 — F2 100% 현재역).
 *
 * 지하에서 GPS가 실패해도 wifi가 잡히면 SSID 패턴 매칭으로 현재 역을 결정한다.
 * - 매핑 데이터: `src/data/subwayWifiSsidMap.json` (역명 → 정규식 패턴 배열)
 * - 정규화: 매칭된 역명은 `applyStationAlias` → `stations.json` 매칭 후 첫 호선의 Station 반환.
 *   환승역의 line 결정은 호출자가 다른 신호(boarding-lock·경로)와 교차해 처리한다.
 *
 * 본 유틸은 pure JS layer. 네이티브 SSID 조회 브릿지(NEHotspotNetwork / WifiManager)와
 * useNearestStation cascade wire는 후속 PR에서 추가한다.
 */
import wifiSsidMapRaw from '../../../data/subwayWifiSsidMap.json';
import { applyStationAlias } from '../../../data/stationAliases';
import { findStationByName } from '../../../shared/utils/stationLookup';
import type { Station } from '../../../shared/types/station';

interface WifiSsidEntry {
  stationName: string;
  patterns: string[];
}

interface WifiSsidMap {
  entries: WifiSsidEntry[];
}

interface CompiledEntry {
  canonicalName: string;
  regexes: RegExp[];
}

const wifiSsidMap = wifiSsidMapRaw as unknown as WifiSsidMap;

let compiledCache: CompiledEntry[] | null = null;

function getCompiledEntries(): CompiledEntry[] {
  if (compiledCache !== null) return compiledCache;
  compiledCache = wifiSsidMap.entries.map((entry) => ({
    canonicalName: applyStationAlias(entry.stationName),
    regexes: entry.patterns.map((p) => new RegExp(p, 'i')),
  }));
  return compiledCache;
}

/**
 * 현재 wifi SSID 문자열을 받아 매칭되는 Station을 반환한다.
 * @param ssid - 네이티브에서 조회한 현재 연결된 wifi SSID. null/empty/매칭 실패 시 null.
 */
export function lookupStationBySsid(ssid: string | null | undefined): Station | null {
  if (typeof ssid !== 'string') return null;
  const trimmed = ssid.trim();
  if (trimmed.length === 0) return null;

  const entries = getCompiledEntries();
  for (const entry of entries) {
    const matched = entry.regexes.some((re) => re.test(trimmed));
    if (!matched) continue;
    const station = findStationByName(entry.canonicalName);
    if (station !== null) return station;
  }
  return null;
}

/**
 * 테스트 전용 — 컴파일된 정규식 캐시를 비운다.
 * 프로덕션 런타임에서는 호출되지 않는다(데이터가 JSON 정적 import이므로 cache 무효화 불필요).
 */
export function __resetWifiSsidLookupCacheForTest(): void {
  compiledCache = null;
}
