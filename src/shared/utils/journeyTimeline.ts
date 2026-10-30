import type { LineNumber } from '../types/station';
import {
  TRANSFER_BUFFER_BREAKPOINTS,
  TRANSFER_BUFFER_LONG_WALK_SECONDS,
  UNKNOWN_WAIT_FLOOR_SECONDS,
} from '../constants/eta';
import { TIMETABLE_DIRECTION_MISMATCH_LINES } from '../constants/timetableDirection';
import { directionOnLine } from './directionOnLine';
import { classifyDayType, classifyPeriod, lookupHeadwaySeconds } from './lineHeadway';
import type { Route } from './stationRoute';
import { findStationByNameAndLine, getStationById } from './stationRoute';
import { findBoardableDeparture } from './timetableShared';
import type { Direction } from './timetableShared';
import { getTransferSeconds } from './transferTimes';

/**
 * 여정 타임라인 엔진 (#1480 PR-C).
 *
 * 한 여정의 "지금부터 도착까지"를 시계(T)를 앞으로 굴리며 구한다. ETA = round((T_end − now) / 60).
 *
 *   T = now
 *     + 출발 도보
 *     + 출발 대기        (탑승 전만)   실시간 → 시간표(출발역·방향을 아는 경우) → 배차간격/2 → 하한
 *   환승마다(완료된 환승은 건너뜀):
 *     + 직전 leg 주행
 *     + 환승 도보 + buffer                       → T_platform
 *     + 환승 대기                                실시간 → 시간표(T_platform 이후 첫 열차) → 배차간격/2 → 하한
 *   + 마지막 leg 주행 + 하차 도보
 *
 * 순수 함수다. 시각(nowMs)과 모든 실시간 입력을 호출자가 주입하며 Date.now()를 읽지 않는다 —
 * 같은 입력은 항상 같은 ETA(결정적 테스트·replay). 3분 고정 대기(DEFAULT_WAIT_MINUTES)는 폐기됐다.
 *
 * 대기 소스 우선순위(사용자 결정 D1=U3):
 *   realtime  호출자가 넘긴 fresh 실시간 대기(초). 출발: 진행방향 도착정보 / 환승: PR-D가 채운다.
 *   timetable 정규화 역명 + directionOnLine 방향 + dayType(T_platform)의 시간표에서 T_platform 이후 첫 열차.
 *             방향 극성이 시간표와 어긋난 노선(TIMETABLE_DIRECTION_MISMATCH_LINES)은 쓰지 않는다.
 *   headway   시간표가 없거나 방향을 모르면 해당 시간대 배차간격/2 (lineHeadways.json).
 *   floor     배차간격도 없으면(심야 closed 등) 하한 + waitUnknown → 화면 "N분+".
 *   ended     막차 이후(시간표 다음 운행일 첫차로 넘어감) — 대기를 합산하지 않고 lastTrainEnded → "막차 종료".
 */

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
/** 배차간격 기반 평균 대기 = 간격의 절반. */
const HEADWAY_WAIT_DIVISOR = 2;

export type WaitSource = 'realtime' | 'timetable' | 'headway' | 'floor' | 'ended';

export interface JourneyWait {
  kind: 'origin' | 'transfer';
  /** 대기하는 열차의 노선 (출발: 탑승 노선 / 환승: toLine). */
  line: LineNumber;
  /** 시간표 조회 좌표. 출발 시간표 슬롯(originStop)이 없으면 null. */
  stationName: string | null;
  source: WaitSource;
  seconds: number;
}

/** 시간표 조회 결과 관측 — alarmLog `boardable-lookup` → boardableMissRatio 입력. */
export interface BoardableLookup {
  status: 'ok' | 'miss';
  line: LineNumber;
  stationName: string;
}

export interface JourneyEta {
  /** 정수 분 (호출처 contract). */
  minutes: number;
  /** 대기 하한(U2)이 쓰였다 — 표시는 "N분+". */
  waitUnknown: boolean;
  /** 막차 이후 — 표시는 "막차 종료". */
  lastTrainEnded: boolean;
  waits: JourneyWait[];
  lookups: BoardableLookup[];
}

export interface JourneyEtaInput {
  route: NonNullable<Route>;
  nowMs: number;
  /** 출발 도보(초). */
  originWalkSeconds?: number;
  /** 하차 도보(초). */
  destinationWalkSeconds?: number;
  /** 탑승 중(출발 대기 소진)이면 true — 출발 대기를 합산하지 않는다. */
  excludeOriginWait?: boolean;
  /** 출발역 진행방향 실시간 대기(초). fresh 판정은 호출자 책임. */
  originRealtimeWaitSeconds?: number | null;
  /** 출발역 시간표 슬롯 — 출발역·방향을 아는 호출자(PR-B)가 채운다. 없으면 배차간격/2. */
  originStop?: { stationName: string; line: LineNumber; direction: Direction } | null;
  /** 환승 순서별 실시간 대기(초). fresh 판정은 호출자 책임. 환승 실시간 주입은 PR-D 소관. */
  transferRealtimeWaitSeconds?: ReadonlyArray<number | null>;
}

interface TransferStep {
  transferName: string;
  fromLine: LineNumber;
  toLine: LineNumber;
  secondsToTransfer: number;
}

interface JourneyShape {
  transfers: readonly TransferStep[];
  /** 마지막 환승 이후(환승 없으면 전체) 주행 초. */
  tailSeconds: number;
  /** 첫 leg 노선. */
  firstLine: LineNumber;
}

function shapeOf(route: NonNullable<Route>): JourneyShape {
  if (route.type === 'direct') {
    return { transfers: [], tailSeconds: route.travelSeconds, firstLine: route.line };
  }
  if (route.type === 'transfer') {
    const { transferName, fromLine, toLine, secondsToTransfer } = route;
    return {
      transfers: [{ transferName, fromLine, toLine, secondsToTransfer }],
      tailSeconds: route.secondsFromTransfer,
      firstLine: fromLine,
    };
  }
  const { transfers } = route;
  return {
    transfers,
    tailSeconds: route.secondsAfterLastTransfer,
    firstLine: transfers[0].fromLine,
  };
}

/**
 * 도보까지 끝난 환승 수와 대기까지 끝난 환승 수 (PR-A, N7).
 * 환승역 toLine 위(transferWaitPending)면 마지막 완료 환승의 도보만 끝났고 대기는 남는다.
 */
function completedCounts(route: NonNullable<Route>): { walkDone: number; waitDone: number } {
  if (route.type === 'direct') return { walkDone: 0, waitDone: 0 };
  const walkDone = route.completedTransfers ?? 0;
  const waitDone = route.transferWaitPending ? Math.max(walkDone - 1, 0) : walkDone;
  return { walkDone, waitDone };
}

/** 도보 시간(초) → 승강장/문 buffer(초). 환승 도보가 없으면(이미 승강장) buffer도 없다. */
function bufferSecondsFor(walkSeconds: number): number {
  if (walkSeconds <= 0) return 0;
  const hit = TRANSFER_BUFFER_BREAKPOINTS.find((b) => walkSeconds <= b.maxWalkingSeconds);
  return hit ? hit.bufferSeconds : TRANSFER_BUFFER_LONG_WALK_SECONDS;
}

/** 환승 i의 toLine 진행 방향 — 환승역 → 다음 waypoint(다음 환승역 or 목적지). 판정 불가면 null. */
function transferDirection(
  route: NonNullable<Route>,
  transfers: readonly TransferStep[],
  index: number,
): Direction | null {
  const { toLine, transferName } = transfers[index];
  const here = findStationByNameAndLine(transferName, toLine);
  const next = transfers[index + 1];
  const { destinationStationId } = route;
  const nextStation = next
    ? findStationByNameAndLine(next.transferName, toLine)
    : destinationStationId
      ? getStationById(destinationStationId)
      : undefined;
  if (!here || !nextStation) return null;
  return directionOnLine(toLine, here.id, nextStation.id);
}

interface WaitRequest {
  kind: JourneyWait['kind'];
  line: LineNumber;
  stationName: string | null;
  direction: Direction | null;
  atMs: number;
  realtimeSeconds: number | null;
}

interface WaitResolution {
  wait: JourneyWait;
  lookup: BoardableLookup | null;
}

function resolveWait(request: WaitRequest): WaitResolution {
  const { kind, line, stationName, direction, atMs, realtimeSeconds } = request;
  const at = new Date(atMs);
  const wait = (source: WaitSource, seconds: number): JourneyWait => ({ kind, line, stationName, source, seconds });

  if (realtimeSeconds !== null) return { wait: wait('realtime', realtimeSeconds), lookup: null };

  let lookup: BoardableLookup | null = null;
  if (stationName !== null) {
    const usable = direction !== null && !TIMETABLE_DIRECTION_MISMATCH_LINES.includes(line);
    const result = usable ? findBoardableDeparture({ stationName, line, direction, from: at }) : null;
    lookup = { status: result?.status === 'ok' ? 'ok' : 'miss', line, stationName };
    if (result?.status === 'ok') {
      const { departure } = result;
      return departure.isNextDayFallback
        ? { wait: wait('ended', 0), lookup }
        : { wait: wait('timetable', departure.waitSeconds), lookup };
    }
  }

  const dayType = classifyDayType(at);
  const headway = lookupHeadwaySeconds(line, dayType, classifyPeriod(at, dayType));
  return headway !== null
    ? { wait: wait('headway', headway / HEADWAY_WAIT_DIVISOR), lookup }
    : { wait: wait('floor', UNKNOWN_WAIT_FLOOR_SECONDS), lookup };
}

export function computeJourneyEta(input: JourneyEtaInput): JourneyEta {
  const { route, nowMs } = input;
  const { transfers, tailSeconds, firstLine } = shapeOf(route);
  const { walkDone, waitDone } = completedCounts(route);

  const waits: JourneyWait[] = [];
  const lookups: BoardableLookup[] = [];
  let cursorMs = nowMs + (input.originWalkSeconds ?? 0) * MS_PER_SECOND;

  const settle = (resolution: WaitResolution): void => {
    const { wait, lookup } = resolution;
    waits.push(wait);
    if (lookup) lookups.push(lookup);
    cursorMs += wait.seconds * MS_PER_SECOND;
  };

  if (!input.excludeOriginWait) {
    const stop = input.originStop ?? null;
    settle(
      resolveWait({
        kind: 'origin',
        line: stop?.line ?? firstLine,
        stationName: stop?.stationName ?? null,
        direction: stop?.direction ?? null,
        atMs: cursorMs,
        realtimeSeconds: input.originRealtimeWaitSeconds ?? null,
      }),
    );
  }

  transfers.forEach((step, index) => {
    cursorMs += step.secondsToTransfer * MS_PER_SECOND;
    if (index < waitDone) return;
    const walkSeconds = index < walkDone ? 0 : getTransferSeconds(step.fromLine, step.toLine, step.transferName);
    cursorMs += (walkSeconds + bufferSecondsFor(walkSeconds)) * MS_PER_SECOND;
    settle(
      resolveWait({
        kind: 'transfer',
        line: step.toLine,
        stationName: step.transferName,
        direction: transferDirection(route, transfers, index),
        atMs: cursorMs,
        realtimeSeconds: input.transferRealtimeWaitSeconds?.[index] ?? null,
      }),
    );
  });

  cursorMs += (tailSeconds + (input.destinationWalkSeconds ?? 0)) * MS_PER_SECOND;

  return {
    minutes: Math.round((cursorMs - nowMs) / MS_PER_SECOND / SECONDS_PER_MINUTE),
    waitUnknown: waits.some((w) => w.source === 'floor'),
    lastTrainEnded: waits.some((w) => w.source === 'ended'),
    waits,
    lookups,
  };
}

export type EtaDisplayKind = 'exact' | 'unknownWait' | 'lastTrainEnded';

/** 화면 표기 분류: 막차 종료가 "N분+"보다 우선한다. ETA 자체가 없으면(null) 'exact'. */
export function etaDisplayKind(flags: Pick<JourneyEta, 'waitUnknown' | 'lastTrainEnded'> | null): EtaDisplayKind {
  if (flags?.lastTrainEnded) return 'lastTrainEnded';
  return flags?.waitUnknown ? 'unknownWait' : 'exact';
}
