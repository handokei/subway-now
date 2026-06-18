/**
 * #1451 (Epic #1432, B3) — WiFi BSSID(MAC) → 역 매핑 유틸.
 *
 * 서울교통공사 tnSubwayWifi 공공데이터셋(scripts/build-wifi-ssid-dataset.js 빌드)을
 * 정적 import하여 BSSID(MAC) 1개당 1 platform을 식별한다.
 *
 * 왜 SSID가 아니라 BSSID인가:
 *   tnSubwayWifi의 SSID 컬럼은 통신사 default 명("T wifi zone", "ollehWiFi", "FREE_U+zone" 등)으로
 *   18601 row 중 90%+ 가 4종 SSID에 집중된다. 즉 SSID 단독으로는 어느 역인지 알 수 없다.
 *   BSSID(MAC 주소)는 platform AP 단위로 unique하므로 환승역의 노선까지 정확히 판별 가능.
 *
 * 본 유틸은 pure JS layer. 네이티브 BSSID 조회 브릿지는 후속 PR(권한/entitlement 검토 포함).
 * `lookupStationBySsid`(SSID 패턴 매칭)는 별도 SSOT로 유지 — 운영 데이터 점진 학습용.
 */
import wifiBssidMapRaw from '../../../data/subwayWifiBssidMap.json';
import { findStationByName } from '../../../shared/utils/stationLookup';
import type { LineNumber, Station } from '../../../shared/types/station';

interface BssidEntry {
  stationName: string;
  line: LineNumber;
  ssid: string;
}

interface BssidMap {
  entries: Record<string, BssidEntry>;
}

const bssidMap = wifiBssidMapRaw as unknown as BssidMap;

export interface BssidLookupResult {
  station: Station;
  line: LineNumber;
  ssid: string;
}

/**
 * BSSID(MAC)는 case-insensitive로 비교한다. 입력 form 다양성(콜론/대시/대문자) 대응을 위한 normalize.
 *   "AA:BB:CC:DD:EE:FF" / "aa-bb-cc-dd-ee-ff" / "AABBCCDDEEFF" → "aa:bb:cc:dd:ee:ff" (콜론 form).
 * 길이 12 hex가 아니면 빈 문자열 반환 — 호출자가 null로 분기.
 */
export function normalizeBssid(value: unknown): string {
  if (typeof value !== 'string') return '';
  const stripped = value.replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  if (stripped.length !== 12) return '';
  const parts: string[] = [];
  for (let i = 0; i < 12; i += 2) parts.push(stripped.slice(i, i + 2));
  return parts.join(':');
}

/**
 * BSSID(MAC)로 platform 역을 정확히 식별한다.
 * 환승역에서도 line이 정확하므로 호출자가 호선 모호성 없이 fusion에 활용 가능.
 *
 * @param bssid - 네이티브에서 조회한 현재 연결된 WiFi의 BSSID(MAC). 미연결/미지원 시 null/empty.
 * @returns 매칭 시 {station, line, ssid}, 미매칭 시 null. station.line은 dataset의 line으로 덮어쓴다.
 */
export function lookupStationByBssid(bssid: string | null | undefined): BssidLookupResult | null {
  if (typeof bssid !== 'string') return null;
  const key = normalizeBssid(bssid);
  if (key.length === 0) return null;
  const entry = bssidMap.entries[key];
  if (!entry) return null;
  const station = findStationByName(entry.stationName);
  if (station === null) return null;
  // dataset의 line이 platform 정답 — stations.json 첫-매칭 line은 환승역에서 다른 호선일 수 있음.
  return {
    station: { ...station, line: entry.line },
    line: entry.line,
    ssid: entry.ssid,
  };
}
