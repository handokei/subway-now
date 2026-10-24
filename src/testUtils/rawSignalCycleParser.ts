/**
 * #2241 (Epic #1927 G4 Phase 0, ADR-030 §Replay harness backbone P0-2) — dump "## Raw Signal"
 * 섹션 → `FusionCycleInput[]` 파서.
 *
 * `dumpParser.ts`(#1833)는 dump의 요약 필드(1개 스냅샷 값)만 추출해 chain-stage 판정에 쓴다.
 * 본 파서는 그와 달리 **cycle 단위 시퀀스**를 그대로 보존한다 — `fusionReplayDriver.ts`가 이
 * 시퀀스를 실제 `inferEnvironment`/`pickFusionTier` 파이프라인에 사이클별로 흘려 재현하려면
 * 각 라인이 개별 관측 단위로 남아야 하기 때문이다 (dumpParser의 "요약값 1개" 추출과는 다른
 * 목적 — 둘은 상호 대체가 아니라 병존).
 *
 * `formatRawSignalLine`(DebugModal.tsx) 출력 포맷을 그대로 역파싱한다:
 * ```
 * HH:MM:SS | kind | stationId | source/confidence | gps(accM/speedMps) | motion |
 *   sub=bool | arvlCd=n | arc=progress | cell=tech/vote | hpa=n | fix=HH:MM:SS
 * ```
 * 마지막 두 토큰(`hpa=`/`fix=`, #2241 P0-1 신규)은 과거 dump에는 없을 수 있다 — 부재 시
 * `barometerHpa`/`gpsFixAtMs`는 null로 graceful 처리한다.
 *
 * dump는 최신 항목이 먼저(reverse) 나열된다(`buildRawSignalSection` = `[...entries].reverse()`).
 * 본 파서는 replay가 사이클을 실제 발생 순서(과거→최근)로 흘릴 수 있도록 **시간 순 재정렬**해
 * 반환한다.
 *
 * 날짜 부재 보정: dump 라인은 `HH:MM:SS`만 담고 날짜가 없다(ring buffer 300 cycle이 여러 날에
 * 걸쳐 누적될 수 있음). 시간순 정렬 후 직전 항목보다 시:분:초가 역행(자정 넘김 추정)하면 날짜를
 * +1일 전진시키는 합성 타임스탬프를 부여한다 — 절대 시각이 아니라 **사이클 간 상대 간격**만
 * replay 불변식(예: "5분 이상 stale GPS")에 의미가 있으므로 이 근사로 충분하다.
 */

export interface FusionCycleInput {
  /** 합성 epoch ms — 절대 시각 아님, 사이클 간 상대 간격 재현용(위 파일 헤더 참고). */
  ts: number;
  kind: 'cycle' | 'enter' | 'exit';
  stationId: string | null;
  source: string | null;
  confidence: string | null;
  accM: number | null;
  speedMps: number | null;
  motion: string | null;
  /** `sub=true|false|—`. `—`(unknown/warmup)는 null. */
  subsurface: boolean | null;
  arvlCd: number | null;
  arcProgress: number | null;
  cellularTech: string | null;
  cellularVote: string | null;
  /** #2241 P0-1 신규 필드. 구 dump(hpa 토큰 부재)는 null. */
  barometerHpa: number | null;
  /** #2241 P0-1 신규 필드. 구 dump(fix 토큰 부재)는 null. */
  gpsFixAtMs: number | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function parseTimeOfDayMs(token: string): number | null {
  const m = token.match(/^(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, hh, mm, ss] = m;
  return (Number(hh) * 3600 + Number(mm) * 60 + Number(ss)) * 1000;
}

function parseNumberOrNull(text: string): number | null {
  if (text === '-' || text === '') return null;
  const n = parseFloat(text);
  return Number.isNaN(n) ? null : n;
}

function parseGpsToken(token: string): { accM: number | null; speedMps: number | null } {
  // "gps(19m/-)" | "gps(23m/3.2m/s)" | "gps(-/-)"
  const m = token.match(/^gps\(([^/]*)\/([^)]*)\)$/);
  if (!m) return { accM: null, speedMps: null };
  const accM = m[1] === '-' ? null : parseNumberOrNull(m[1].replace(/m$/, ''));
  const speedMps = m[2] === '-' ? null : parseNumberOrNull(m[2].replace(/m\/s$/, ''));
  return { accM, speedMps };
}

function parseSubsurfaceToken(token: string): boolean | null {
  // "sub=true" | "sub=false" | "sub=—"
  const value = token.slice('sub='.length);
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

function parseKeyEqValue(token: string, key: string): string {
  return token.slice(`${key}=`.length);
}

function parseCellularToken(token: string): { tech: string | null; vote: string | null } {
  // "cell=NRNSA/surface-weak-nrnsa" | "cell=-"
  const value = parseKeyEqValue(token, 'cell');
  if (value === '-') return { tech: null, vote: null };
  const slash = value.indexOf('/');
  if (slash === -1) return { tech: null, vote: value || null };
  const tech = value.slice(0, slash);
  const vote = value.slice(slash + 1);
  return { tech: tech || null, vote: vote || null };
}

/**
 * `## Raw Signal` 섹션 헤더 이후 다음 `## ` 헤더 전까지의 텍스트를 추출.
 * 섹션 부재면 undefined.
 */
function extractRawSignalSection(dumpText: string): string | undefined {
  const headerMatch = dumpText.match(/^## Raw Signal(?: \(\d+\))?$/m);
  if (!headerMatch) return undefined;
  // 성공한(non-global) 정규식 match는 index가 항상 정의된다 — 방어적 `?? 0` fallback은
  // 도달 불가 분기라 coverage 100%를 해쳐 제거(non-null assertion으로 명시).
  const start = headerMatch.index! + headerMatch[0].length;
  const nextSection = dumpText.indexOf('\n## ', start);
  return (nextSection === -1 ? dumpText.slice(start) : dumpText.slice(start, nextSection)).trim();
}

/**
 * 한 줄(dump 순서 그대로, 시간 무관)을 파싱. 파싱 불가 필드는 null.
 * 완전히 형식이 안 맞는 라인(토큰 10개 미만)은 null 반환 — caller가 skip한다.
 */
function parseLine(line: string): FusionCycleInput | null {
  const tokens = line.split(' | ').map((t) => t.trim());
  if (tokens.length < 10) return null;
  const [timeTok, kindTok, stationIdTok, sourceConfTok, gpsTok, motionTok, subTok, arvlTok, arcTok, cellTok, hpaTok, fixTok] =
    tokens;

  const timeOfDayMs = parseTimeOfDayMs(timeTok);
  if (timeOfDayMs === null) return null;
  if (kindTok !== 'cycle' && kindTok !== 'enter' && kindTok !== 'exit') return null;

  const [sourceRaw, confidenceRaw] = sourceConfTok.split('/');
  const { accM, speedMps } = parseGpsToken(gpsTok);
  const { tech: cellularTech, vote: cellularVote } = parseCellularToken(cellTok);

  return {
    ts: timeOfDayMs, // caller re-bases with day rollover — see parseRawSignalCycles.
    kind: kindTok,
    stationId: stationIdTok === '-' ? null : stationIdTok,
    source: sourceRaw === '-' ? null : sourceRaw,
    confidence: confidenceRaw === '-' ? null : confidenceRaw,
    accM,
    speedMps,
    motion: motionTok === '-' ? null : motionTok,
    subsurface: parseSubsurfaceToken(subTok),
    arvlCd: arvlTok === 'arvlCd=-' ? null : parseNumberOrNull(parseKeyEqValue(arvlTok, 'arvlCd')),
    arcProgress: arcTok === 'arc=-' ? null : parseNumberOrNull(parseKeyEqValue(arcTok, 'arc')),
    cellularTech,
    cellularVote,
    barometerHpa:
      hpaTok === undefined || hpaTok === 'hpa=-' ? null : parseNumberOrNull(parseKeyEqValue(hpaTok, 'hpa')),
    gpsFixAtMs: fixTok === undefined || fixTok === 'fix=-' ? null : parseTimeOfDayMs(parseKeyEqValue(fixTok, 'fix')),
  };
}

/**
 * dump 텍스트 전체에서 `## Raw Signal` 섹션을 추출해 `FusionCycleInput[]`로 파싱.
 * 시간순(과거→최근)으로 정렬해 반환 — dump 원본은 최신이 먼저(reverse) 나열된다.
 *
 * 섹션 부재 / 파싱 가능 라인 0건이면 빈 배열.
 */
export function parseRawSignalCycles(dumpText: string): FusionCycleInput[] {
  const section = extractRawSignalSection(dumpText);
  if (!section) return [];

  const dumpOrderNewestFirst = section
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map(parseLine)
    .filter((entry): entry is FusionCycleInput => entry !== null);

  // dump는 최신→과거 순. replay는 과거→최신이 필요하므로 뒤집는다.
  const chronological = [...dumpOrderNewestFirst].reverse();

  // 날짜 부재 보정 — 시:분:초가 직전보다 역행하면 자정을 넘겼다고 간주하고 dayBase +1일.
  let dayBase = 0;
  let prevTimeOfDayMs: number | null = null;
  return chronological.map((entry) => {
    if (prevTimeOfDayMs !== null && entry.ts < prevTimeOfDayMs) {
      dayBase += DAY_MS;
    }
    prevTimeOfDayMs = entry.ts;
    const rebasedGpsFixAtMs =
      entry.gpsFixAtMs === null
        ? null
        : // fix는 같은 cycle 관측치이므로 동일 dayBase 적용(자정 boundary 오차는 P0 근사 범위 밖).
          dayBase + entry.gpsFixAtMs;
    return { ...entry, ts: dayBase + entry.ts, gpsFixAtMs: rebasedGpsFixAtMs };
  });
}
