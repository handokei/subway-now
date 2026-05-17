/**
 * 클라이언트 line code(stations.json의 `line` 필드) → Seoul API `subwayNm` 후보 매핑.
 *
 * Seoul API는 "지하철1호선", "지하철경의중앙선" 등 한글명을 돌려준다.
 * 영문 코드(`gyeongui`, `airport` 등)는 substring 매칭으로는 절대 잡히지 않으므로
 * 명시적 alias 배열로 매칭한다. 숫자 호선("1"~"9")은 "지하철1호선" 같은 접미 형식 매칭.
 *
 * 신규 노선은 이 맵에 alias를 추가하기만 하면 매칭에 반영된다.
 */

export const LINE_ALIAS_MAP: Record<string, readonly string[]> = {
  '1': ['지하철1호선', '1호선'],
  '2': ['지하철2호선', '2호선'],
  '3': ['지하철3호선', '3호선'],
  '4': ['지하철4호선', '4호선'],
  '5': ['지하철5호선', '5호선'],
  '6': ['지하철6호선', '6호선'],
  '7': ['지하철7호선', '7호선'],
  '8': ['지하철8호선', '8호선'],
  '9': ['지하철9호선', '9호선'],
  gyeongui: ['경의중앙선', '지하철경의중앙선', '경의중앙'],
  bundang: ['수인분당선', '지하철수인분당선', '분당선', '수인분당'],
  sinbundang: ['신분당선', '지하철신분당선'],
  airport: ['공항철도', '인천국제공항철도'],
};

/**
 * Seoul API의 subwayNm이 클라이언트 line code와 매칭되는지 판정한다.
 *
 * 우선순위:
 *   1. line code에 대응되는 alias 배열 중 하나가 subwayNm과 정확히 일치하거나
 *      subwayNm이 alias를 포함하면 true (예: subwayNm="지하철경의중앙선", alias="경의중앙선")
 *   2. alias 매핑이 없는 경우 (예: 신규 노선) substring 매칭으로 fallback
 */
export function matchLine(subwayNm: string, line: string): boolean {
  if (!subwayNm || !line) return false;

  const aliases = LINE_ALIAS_MAP[line];
  if (aliases) {
    for (const alias of aliases) {
      if (subwayNm === alias) return true;
      if (subwayNm.includes(alias) || alias.includes(subwayNm)) return true;
    }
    return false;
  }

  return subwayNm.includes(line) || line.includes(subwayNm);
}
