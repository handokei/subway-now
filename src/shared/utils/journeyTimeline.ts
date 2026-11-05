import type { LineNumber } from '../types/station';
import {
  TRANSFER_BUFFER_BREAKPOINTS,
  TRANSFER_BUFFER_LONG_WALK_SECONDS,
  TRANSFER_RESELECT_DEPARTURE_COUNT,
  UNKNOWN_WAIT_FLOOR_SECONDS,
} from '../constants/eta';
import { TIMETABLE_DIRECTION_MISMATCH_LINES } from '../constants/timetableDirection';
import { directionOnLine } from './directionOnLine';
import { classifyDayType, classifyPeriod, lookupHeadwaySeconds } from './lineHeadway';
import type { Route } from './stationRoute';
import { findStationByNameAndLine, getStationById } from './stationRoute';
import { findBoardableDeparture, formatMinutesAsHHmm } from './timetableShared';
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
 *   realtime  호출자가 넘긴 fresh 실시간 대기(초). 출발: 진행방향 도착정보 / 환승: PR-D의 boardable 후보(transferBoardableArrivalsMs)가 채운다.
 *   timetable 정규화 역명 + directionOnLine 방향 + dayType(T_platform)의 시간표에서 T_platform 이후 첫 열차.
 *             방향 극성이 시간표와 어긋난 노선(TIMETABLE_DIRECTION_MISMATCH_LINES)은 쓰지 않는다.
 *   headway   시간표가 없거나 방향을 모르면 해당 시간대 배차간격/2 (lineHeadways.json).
 *   floor     배차간격도 없으면(심야 closed 등) 하한 + waitUnknown → 화면 "N분+".
 *   ended     막차 이후(시간표 다음 운행일 첫차로 넘어감) — 대기를 합산하지 않고 lastTrainEnded → "막차 종료".
 */

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MS_PER_MINUTE = MS_PER_SECOND * SECONDS_PER_MINUTE;
const KST_OFFSET_MS = 9 * 60 * MS_PER_MINUTE;
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
  /** source='ended'이고 시간표가 첫 운행을 알려줄 때 그 첫차 출발 시각(절대 epoch ms). 판정에는 쓰지 않는다. */
  firstTrainAtMs?: number;
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
  /** 반올림 전 총 초 — backend 재선택 재료(PR-E)가 대기 제외 주행을 정확히 뽑는 데 쓴다. */
  totalSeconds: number;
  /** 대기 하한(U2)이 쓰였다 — 표시는 "N분+". */
  waitUnknown: boolean;
  /** 막차 이후 — 표시는 "막차 종료". */
  lastTrainEnded: boolean;
  /** lastTrainEnded이고 막힌 첫 지점이 출발역일 때 그 시간표 첫차 시각(epoch ms). 환승역에서 막혔거나 시간표 미커버면 undefined → "막차 종료". */
  firstTrainAtMs?: number;
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
  /**
   * 환승 순서별 환승역 실시간 도착 후보(절대 epoch ms) — toLine·진행 방향으로 이미 거른 fresh 열차.
   * 엔진이 T_platform 이후 첫 열차(boardable)를 고른다. 없거나 boardable이 없으면 시간표로 폴백. (#1480 PR-D)
   */
  transferBoardableArrivalsMs?: ReadonlyArray<ReadonlyArray<number> | null>;
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

function firstTransferStationId(route: Exclude<NonNullable<Route>, { type: 'direct' }>, firstLine: LineNumber): string | undefined {
  const first = route.type === 'transfer' ? route : route.transfers[0];
  return first.transferStationId ?? findStationByNameAndLine(first.transferName, firstLine)?.id;
}

export type OriginStop = NonNullable<JourneyEtaInput['originStop']>;

/**
 * 출발역 시간표 슬롯 (#1480). 출발역·첫 leg 노선·진행 방향(출발역 → 첫 waypoint)을 route와 출발역 id로 구한다.
 * 출발역이 첫 leg 노선 위가 아니거나 방향을 판정할 수 없으면 null — 엔진은 배차간격/2 → floor로 폴백한다.
 */
export function resolveOriginStop(route: NonNullable<Route>, originStationId: string): OriginStop | null {
  const origin = getStationById(originStationId);
  const { firstLine } = shapeOf(route);
  if (!origin || origin.line !== firstLine) return null;
  const nextId = route.type === 'direct' ? route.destinationStationId : firstTransferStationId(route, firstLine);
  const direction = nextId ? directionOnLine(firstLine, originStationId, nextId) : null;
  return direction ? { stationName: origin.name, line: firstLine, direction } : null;
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
  /** T_platform 이후 첫 열차를 고를 실시간 도착 후보(절대 ms). */
  boardableArrivalsMs?: ReadonlyArray<number> | null;
}

interface WaitResolution {
  wait: JourneyWait;
  lookup: BoardableLookup | null;
}

/** 시간표를 대기 소스로 쓸 수 있는가 — 방향을 알고, 시간표 극성이 어긋난 노선이 아니다. */
function canUseTimetable(line: LineNumber, direction: Direction | null): direction is Direction {
  return direction !== null && !TIMETABLE_DIRECTION_MISMATCH_LINES.includes(line);
}

function resolveWait(request: WaitRequest): WaitResolution {
  const { kind, line, stationName, direction, atMs, realtimeSeconds, boardableArrivalsMs } = request;
  const at = new Date(atMs);
  const wait = (source: WaitSource, seconds: number): JourneyWait => ({ kind, line, stationName, source, seconds });

  const boardableMs = (boardableArrivalsMs ?? []).filter((t) => t >= atMs).sort((a, b) => a - b)[0];
  if (boardableMs !== undefined) {
    return { wait: wait('realtime', (boardableMs - atMs) / MS_PER_SECOND), lookup: null };
  }
  if (realtimeSeconds !== null) return { wait: wait('realtime', realtimeSeconds), lookup: null };

  let lookup: BoardableLookup | null = null;
  if (stationName !== null) {
    const result = canUseTimetable(line, direction)
      ? findBoardableDeparture({ stationName, line, direction, from: at })
      : null;
    lookup = { status: result?.status === 'ok' ? 'ok' : 'miss', line, stationName };
    if (result?.status === 'ok') {
      const { departure } = result;
      return departure.isNextDayFallback
        ? { wait: { ...wait('ended', 0), firstTrainAtMs: atMs + departure.waitSeconds * MS_PER_SECOND }, lookup }
        : { wait: wait('timetable', departure.waitSeconds), lookup };
    }
  }

  const dayType = classifyDayType(at);
  const period = classifyPeriod(at, dayType);
  const headway = lookupHeadwaySeconds(line, dayType, period);
  if (headway !== null) return { wait: wait('headway', headway / HEADWAY_WAIT_DIVISOR), lookup };
  // 운행 시간 밖(closed)은 "N분+"가 아니라 막차 종료. 그 외 null(데이터 누락)만 하한.
  return period === 'closed'
    ? { wait: wait('ended', 0), lookup }
    : { wait: wait('floor', UNKNOWN_WAIT_FLOOR_SECONDS), lookup };
}

/**
 * 여정에서 처음 막히는(ended) 지점이 출발역일 때만 그 첫차 시각을 쓴다.
 * 출발역은 운행 중인데 환승역에서 막차가 끊기면 환승역 첫차는 "출발 시각"이 아니므로 싣지 않는다 → "막차 종료".
 */
function firstTrainAtMsOf(waits: readonly JourneyWait[]): number | undefined {
  const firstEnded = waits.find((w) => w.source === 'ended');
  return firstEnded?.kind === 'origin' ? firstEnded.firstTrainAtMs : undefined;
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
        boardableArrivalsMs: input.transferBoardableArrivalsMs?.[index] ?? null,
      }),
    );
  });

  cursorMs += (tailSeconds + (input.destinationWalkSeconds ?? 0)) * MS_PER_SECOND;

  const totalSeconds = (cursorMs - nowMs) / MS_PER_SECOND;
  return {
    minutes: Math.round(totalSeconds / SECONDS_PER_MINUTE),
    totalSeconds,
    waitUnknown: waits.some((w) => w.source === 'floor'),
    lastTrainEnded: waits.some((w) => w.source === 'ended'),
    firstTrainAtMs: firstTrainAtMsOf(waits),
    waits,
    lookups,
  };
}

/** 첫차 시각(epoch ms) → KST "HH:mm". */
export function formatFirstTrainTime(epochMs: number): string {
  return formatMinutesAsHHmm(Math.floor((epochMs + KST_OFFSET_MS) / MS_PER_MINUTE));
}

export type EtaDisplayKind = 'exact' | 'unknownWait' | 'lastTrainEnded';

/** 화면 표기 분류: 막차 종료가 "N분+"보다 우선한다. ETA 자체가 없으면(null) 'exact'. */
export function etaDisplayKind(flags: Pick<JourneyEta, 'waitUnknown' | 'lastTrainEnded'> | null): EtaDisplayKind {
  if (flags?.lastTrainEnded) return 'lastTrainEnded';
  return flags?.waitUnknown ? 'unknownWait' : 'exact';
}

/**
 * 환승 대기 재선택 재료 (#1480 PR-E, plan B2).
 *
 * 등록 시점에 확정한 환승 대기(고정값)는 열차가 지연되면 어긋난다. 그래서 backend가 push마다 "lock 열차의 실시간 환승역
 * 도착 + 도보" 이후 첫 출발을 다시 고를 수 있게, 그 환승의 해당 방향 시간표 다음 출발 K개와 도보·주행을 넘긴다.
 *
 * `route`는 환승역 fromLine 위에 앵커링된 경로(첫 미완료 환승이 이 환승), `arrivalMs`는 그 환승역 도달 예상 시각.
 * 시간표를 쓸 수 없으면(방향 미상·극성 불일치·역 miss·막차 이후) null — backend는 기존 remainingSecToDest로 폴백한다.
 */
export interface TransferReselectPlan {
  /** 도보 + buffer (초) — 환승역 도착부터 승강장 준비까지. */
  walkSeconds: number;
  /** 환승 도보 이후 시간표 다음 출발 K개 (epoch ms, 오름차순). */
  departuresEpochMs: number[];
  /** 이 환승의 도보·대기를 제외한 나머지 주행 (초, 반올림 없음; 이후 환승의 stamp 대기 포함). */
  rideSeconds: number;
}

export function planTransferReselect(route: NonNullable<Route>, arrivalMs: number): TransferReselectPlan | null {
  const { transfers } = shapeOf(route);
  const { walkDone, waitDone } = completedCounts(route);
  const index = waitDone;
  if (index >= transfers.length) return null;
  const step = transfers[index];
  const { toLine, transferName } = step;
  const direction = transferDirection(route, transfers, index);
  if (!canUseTimetable(toLine, direction)) return null;

  const walkSeconds = index < walkDone ? 0 : getTransferSeconds(step.fromLine, step.toLine, transferName);
  const platformSeconds = walkSeconds + bufferSecondsFor(walkSeconds);
  const platformMs = arrivalMs + (step.secondsToTransfer + platformSeconds) * MS_PER_SECOND;

  const departuresEpochMs: number[] = [];
  let fromMs = platformMs;
  while (departuresEpochMs.length < TRANSFER_RESELECT_DEPARTURE_COUNT) {
    const result = findBoardableDeparture({ stationName: transferName, line: toLine, direction, from: new Date(fromMs) });
    if (result.status !== 'ok' || result.departure.isNextDayFallback) break;
    const departureMs = fromMs + result.departure.waitSeconds * MS_PER_SECOND;
    departuresEpochMs.push(departureMs);
    fromMs = departureMs + SECONDS_PER_MINUTE * MS_PER_SECOND; // 시간표 해상도 = 1분 — 같은 분은 같은 열차.
  }
  if (departuresEpochMs.length === 0) return null;

  const { totalSeconds, waits } = computeJourneyEta({ route, nowMs: arrivalMs, excludeOriginWait: true });
  const [firstWait] = waits;
  const rideSeconds = Math.max(totalSeconds - step.secondsToTransfer - platformSeconds - firstWait.seconds, 0);
  return { walkSeconds: platformSeconds, departuresEpochMs, rideSeconds };
}
