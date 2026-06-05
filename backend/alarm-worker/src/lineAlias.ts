/**
 * 클라이언트 line code(stations.json의 `line` 필드) → Seoul API 노선명 매핑.
 *
 * 단일 데이터 소스: `LINE_META`만 유지하고, 모든 헬퍼는 여기서 파생된다.
 * 신규 노선은 이 맵에 한 줄만 추가하면 `canonicalLineName` / `matchLine` /
 * Live Activity ContentState(lineName/lineColorHex) 모두 자동 반영.
 *
 * - `canonical`: realtimePosition API의 `subwayLine` URL 파라미터에 들어가는 정식명 ("1호선", "경의중앙선").
 *   "지하철1호선" 접두형은 들어가지 않는다. Live Activity의 `lineName`도 이 값을 그대로 사용.
 * - `aliases`: realtimeStationArrival 응답의 `subwayNm` 등 다른 형태 — substring 매칭에 사용.
 * - `color`: Live Activity 위젯 노선 색상 hex (예: "#0052A4"). frontend `src/constants/lineColors.ts`의
 *   `LINE_COLORS`와 동일 값. 신규 노선 추가 시 양쪽 모두 갱신.
 */

export interface LineMeta {
  canonical: string;
  aliases: readonly string[];
  color: string;
  /**
   * Seoul Open API subwayId (예: "1007" = 7호선). #902 Seam F — 환승 자동 swap이
   * 새 노선 lock을 합성할 때 클라가 송신하던 subwayId의 backend-side 대체.
   * 클라의 `src/shared/constants/lineApiNames.ts`의 LINE_TO_SUBWAY_ID와 정합 유지.
   */
  subwayId: string;
}

export const LINE_META: Record<string, LineMeta> = {
  '1': { canonical: '1호선', aliases: ['지하철1호선'], color: '#0052A4', subwayId: '1001' },
  '2': { canonical: '2호선', aliases: ['지하철2호선'], color: '#009D3E', subwayId: '1002' },
  '3': { canonical: '3호선', aliases: ['지하철3호선'], color: '#EF7C1C', subwayId: '1003' },
  '4': { canonical: '4호선', aliases: ['지하철4호선'], color: '#00A2D1', subwayId: '1004' },
  '5': { canonical: '5호선', aliases: ['지하철5호선'], color: '#996CAC', subwayId: '1005' },
  '6': { canonical: '6호선', aliases: ['지하철6호선'], color: '#CD7C2F', subwayId: '1006' },
  '7': { canonical: '7호선', aliases: ['지하철7호선'], color: '#747F00', subwayId: '1007' },
  '8': { canonical: '8호선', aliases: ['지하철8호선'], color: '#E6186C', subwayId: '1008' },
  '9': { canonical: '9호선', aliases: ['지하철9호선'], color: '#BDB092', subwayId: '1009' },
  gyeongui: {
    canonical: '경의중앙선',
    aliases: ['지하철경의중앙선', '경의중앙'],
    color: '#77C4A3',
    subwayId: '1063',
  },
  bundang: {
    canonical: '수인분당선',
    aliases: ['지하철수인분당선', '분당선', '수인분당'],
    color: '#F5A200',
    subwayId: '1075',
  },
  sinbundang: {
    canonical: '신분당선',
    aliases: ['지하철신분당선'],
    color: '#D4003B',
    subwayId: '1077',
  },
  airport: { canonical: '공항철도', aliases: ['인천국제공항철도'], color: '#4B81BF', subwayId: '1065' },
};

/** realtimePosition URL 파라미터용 정식 노선명. 매핑 없으면 null. */
export function canonicalLineName(line: string): string | null {
  return LINE_META[line]?.canonical ?? null;
}

/**
 * #902 Seam F — line code → Seoul API subwayId. 환승 자동 swap이 새 lock을 합성할 때 사용.
 * 매핑 없는 line이면 null — caller가 swap 자체를 abort한다.
 */
export function subwayIdForLine(line: string): string | null {
  return LINE_META[line]?.subwayId ?? null;
}

/**
 * 기존 호환성 — LINE_META에서 파생되는 alias 목록. 신규 코드는 LINE_META를 직접 사용 권장.
 */
export const LINE_ALIAS_MAP: Record<string, readonly string[]> = Object.fromEntries(
  Object.entries(LINE_META).map(([line, { canonical, aliases }]) => [line, [canonical, ...aliases]]),
);

/**
 * Seoul API의 subwayNm이 클라이언트 line code와 매칭되는지 판정한다.
 *
 * 우선순위:
 *   1. line code에 대응되는 `[canonical, ...aliases]` 중 하나가 subwayNm과 정확히 일치하거나
 *      subwayNm이 alias를 포함하면 true
 *   2. 매핑이 없는 경우 (예: 신규 노선) substring 매칭으로 fallback
 */
export function matchLine(subwayNm: string, line: string): boolean {
  if (!subwayNm || !line) return false;

  const meta = LINE_META[line];
  if (meta) {
    const candidates = [meta.canonical, ...meta.aliases];
    for (const name of candidates) {
      if (subwayNm === name) return true;
      if (subwayNm.includes(name) || name.includes(subwayNm)) return true;
    }
    return false;
  }

  return subwayNm.includes(line) || line.includes(subwayNm);
}
