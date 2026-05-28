/**
 * 클라이언트 line code(stations.json의 `line` 필드) → Seoul API 노선명 매핑.
 *
 * 단일 데이터 소스: `LINE_META`만 유지하고, 모든 헬퍼는 여기서 파생된다.
 * 신규 노선은 이 맵에 한 줄만 추가하면 `canonicalLineName` / `matchLine` 양쪽에 자동 반영.
 *
 * - `canonical`: realtimePosition API의 `subwayLine` URL 파라미터에 들어가는 정식명 ("1호선", "경의중앙선").
 *   "지하철1호선" 접두형은 들어가지 않는다.
 * - `aliases`: realtimeStationArrival 응답의 `subwayNm` 등 다른 형태 — substring 매칭에 사용.
 */

export interface LineMeta {
  canonical: string;
  aliases: readonly string[];
}

export const LINE_META: Record<string, LineMeta> = {
  '1': { canonical: '1호선', aliases: ['지하철1호선'] },
  '2': { canonical: '2호선', aliases: ['지하철2호선'] },
  '3': { canonical: '3호선', aliases: ['지하철3호선'] },
  '4': { canonical: '4호선', aliases: ['지하철4호선'] },
  '5': { canonical: '5호선', aliases: ['지하철5호선'] },
  '6': { canonical: '6호선', aliases: ['지하철6호선'] },
  '7': { canonical: '7호선', aliases: ['지하철7호선'] },
  '8': { canonical: '8호선', aliases: ['지하철8호선'] },
  '9': { canonical: '9호선', aliases: ['지하철9호선'] },
  gyeongui: { canonical: '경의중앙선', aliases: ['지하철경의중앙선', '경의중앙'] },
  bundang: { canonical: '수인분당선', aliases: ['지하철수인분당선', '분당선', '수인분당'] },
  sinbundang: { canonical: '신분당선', aliases: ['지하철신분당선'] },
  airport: { canonical: '공항철도', aliases: ['인천국제공항철도'] },
};

/** realtimePosition URL 파라미터용 정식 노선명. 매핑 없으면 null. */
export function canonicalLineName(line: string): string | null {
  return LINE_META[line]?.canonical ?? null;
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
