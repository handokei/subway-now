/**
 * #3155 — 앵커역 출발 열차 기록/조회 (trip 171 오선택 재발 방지).
 *
 * 배경: 탑승 열차 목록이 "접근 중" 열차만 보여, 사용자가 방금 탄(=앵커역을 막 떠난) 열차가 출발 즉시
 * 목록에서 사라진다. trip 171 — 2011 탑승 → 출발 2초 뒤 첫 행이 다음 열차 3013 → 탭 → 오선택.
 * 사용자 결정: 앵커역을 최근 10분 내 출발한 열차도 목록에 나와야 하고, 그 탭도 동급으로 lock된다.
 *
 * 왜 self-poll stamp에 싣는가
 * ---------------------------
 * backend는 이미 매 tick 활성 노선의 realtimePosition 전수를 KV(`realtime-position:<line>`)에 stamp한다.
 * "어느 역에서 어느 열차가 떠났는가"는 trip이 아니라 **노선 피드의 속성**이므로, 그 stamp에 역별 로그를
 * 같이 싣는다. 같은 put에 payload만 늘어나므로 **추가 KV write 0**(#2073 쿼터 교훈 — 신규 per-tick write 금지).
 * 직전 stamp(`existing`)와 이번 fetch를 비교하는 것이 전부라 별도 상태 저장소가 없다.
 *
 * 출발 판정(`updateStationTrainLogs`)
 * ----------------------------------
 *  - 추적 역에서 trainSttus=2(출발) 관측 → 그 position 수신 시각(recptnMs)이 출발 시각.
 *  - 직전 tick에 역에 있던(진입/도착) 열차가 이번 tick 다른 역에서 보임 → 두 관측 시각의 중간.
 *  - 피드에서 아예 사라진 열차는 출발로 단정하지 않는다(관측 공백 ≠ 출발) — 앵커 통과 증거가 없다.
 *  - 앵커에서 한 번도 관측하지 못한 열차는 기록하지 않는다("앵커를 통과한 적 없음").
 *
 * 한계(정직): 기록 해상도는 cron 주기(≈60s) + position 갱신 지연이다. trip 171에서 2011의 출발(06:36:28)은
 * 06:37:45 cycle에서야 backend에 보인다(그 전 cycle은 sts=1 rcv 06:35:18).
 */
import { TRAIN_STATUS } from './alarm';
import { buildLegSegmentStations } from './lockSwap';
import { inferLegDirection } from './legDirection';
import { POSITION_FRESHNESS_MS, resolveActiveLegOrigin } from './boardingAnchorResolver';
import type { PositionEntry } from './seoul';
import type { Trip, Waypoint } from './types';

/** 출발 열차를 목록/corroboration 근거로 유지하는 창(ms) — 사용자 결정(2026-10-21): 10분. */
export const ANCHOR_DEPARTURE_WINDOW_MS = 10 * 60_000;

export interface StationPresence {
  trainCode: string;
  isUp: boolean;
  seenAt: number;
}

export interface StationDeparture {
  trainCode: string;
  isUp: boolean;
  departedAt: number;
}

export interface StationTrainLog {
  /** 마지막 관측 때 이 역에 서 있던(진입/도착) 열차 — 다음 tick에 사라지면 출발 판정 근거. */
  present: StationPresence[];
  /** 최근 `ANCHOR_DEPARTURE_WINDOW_MS` 내 이 역을 출발한 열차. */
  departed: StationDeparture[];
}

/** 역명 → 로그. self-poll stamp의 `stationLogs`. */
export type StationTrainLogs = Record<string, StationTrainLog>;

/** 앵커역 기준으로 backend가 이 열차를 본 방식. null = 한 번도 못 봤다(또는 방향/창 불일치). */
export type AnchorSighting = 'at-anchor' | 'departed' | 'approaching' | null;

export interface AnchorForSighting {
  station: string;
  /** realtimePosition `isUp`과 같은 의미. */
  isUp: boolean;
  /** [앵커, 다음 정차역...] — 앵커 이후(진행 방향) 역. */
  segmentStations: readonly string[];
}

const trainKey = (trainCode: string, isUp: boolean): string => `${trainCode}|${isUp ? 'u' : 'd'}`;

/** recptnMs 0(누락)은 신뢰 불가가 아니라 "관측 시각 모름" — 이번 tick 관측으로 취급한다. */
export function isFreshPosition(position: PositionEntry, now: number): boolean {
  return position.recptnMs <= 0 || now - position.recptnMs <= POSITION_FRESHNESS_MS;
}

const observedAt = (position: PositionEntry, now: number): number =>
  position.recptnMs > 0 ? position.recptnMs : now;

const withinWindow = (at: number, now: number): boolean => now - at <= ANCHOR_DEPARTURE_WINDOW_MS;

/**
 * 직전 stamp의 역별 로그와 이번 position fetch를 비교해 새 로그를 만든다(순수). 추적 역(`tracked`)만
 * 기록하며, 비어 있으면 undefined(필드 생략 → stamp 크기 불변).
 */
export function updateStationTrainLogs(
  prev: StationTrainLogs | undefined,
  positions: readonly PositionEntry[],
  tracked: ReadonlySet<string>,
  now: number,
): StationTrainLogs | undefined {
  const next: StationTrainLogs = {};
  for (const station of tracked) {
    const prevLog = prev?.[station];
    const departed = new Map<string, StationDeparture>();
    for (const d of prevLog?.departed ?? []) {
      if (withinWindow(d.departedAt, now)) departed.set(trainKey(d.trainCode, d.isUp), d);
    }
    const present = new Map<string, StationPresence>();

    const atStation = positions.filter((p) => p.stationName === station && isFreshPosition(p, now));
    const atStationKeys = new Set<string>();
    for (const p of atStation) {
      const key = trainKey(p.trainCode, p.isUp);
      atStationKeys.add(key);
      if (p.trainSttus === TRAIN_STATUS.DEPARTED) {
        if (!departed.has(key)) {
          departed.set(key, { trainCode: p.trainCode, isUp: p.isUp, departedAt: observedAt(p, now) });
        }
      } else {
        present.set(key, { trainCode: p.trainCode, isUp: p.isUp, seenAt: observedAt(p, now) });
      }
    }

    for (const was of prevLog?.present ?? []) {
      const key = trainKey(was.trainCode, was.isUp);
      if (atStationKeys.has(key)) continue;
      const seenElsewhere = positions.some(
        (p) => p.trainCode === was.trainCode && p.isUp === was.isUp && p.stationName !== station,
      );
      if (seenElsewhere) {
        if (!departed.has(key)) {
          departed.set(key, {
            trainCode: was.trainCode,
            isUp: was.isUp,
            departedAt: Math.floor((was.seenAt + now) / 2),
          });
        }
      } else if (withinWindow(was.seenAt, now)) {
        present.set(key, was);
      }
    }

    if (present.size > 0 || departed.size > 0) {
      next[station] = { present: [...present.values()], departed: [...departed.values()] };
    }
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

/** 목록용 — 같은 방향, 10분 이내, 최근 출발 순. */
export function departedFromStation(
  logs: StationTrainLogs | undefined,
  station: string,
  isUp: boolean,
  now: number,
): StationDeparture[] {
  const departed = logs?.[station]?.departed ?? [];
  return departed
    .filter((d) => d.isUp === isUp && withinWindow(d.departedAt, now))
    .sort((a, b) => b.departedAt - a.departedAt);
}

/**
 * backend가 이 열차를 앵커역에서 어떻게 봤는가. 수동 탭(sync) corroboration과 목록이 같은 판정을 쓴다.
 *  - departed: 앵커 출발 기록(10분 이내) — 지금 몇 정거장 앞에 있어도 유효.
 *  - at-anchor: 앵커 역에 서 있는(진입/도착/출발) 같은 방향 열차.
 *  - approaching: 앵커 이전(진행 구간 밖) 역에 있는 같은 방향 열차 — 아직 앵커를 지나지 않았다.
 *  - null: 진행 구간 안에 있는데 출발 기록이 없는 코드(앵커를 한 번도 못 봤다) / 반대 방향 / 피드에 없음.
 */
export function classifyAnchorSighting(
  trainCode: string,
  anchor: AnchorForSighting,
  positions: readonly PositionEntry[],
  logs: StationTrainLogs | undefined,
  now: number,
): AnchorSighting {
  const departed = departedFromStation(logs, anchor.station, anchor.isUp, now);
  if (departed.some((d) => d.trainCode === trainCode)) return 'departed';

  const own = positions.filter(
    (p) => p.trainCode === trainCode && p.isUp === anchor.isUp && isFreshPosition(p, now),
  );
  if (own.some((p) => p.stationName === anchor.station)) return 'at-anchor';

  const beyondAnchor = new Set(anchor.segmentStations.slice(1));
  if (own.some((p) => !beyondAnchor.has(p.stationName))) return 'approaching';
  return null;
}

/** [앵커, 다음역...] 구간에서 앵커/방향을 만든다. 방향 불명(구간 1개/미매핑)은 null — fail-closed(#2944). */
export function anchorFromSegment(
  line: string,
  segmentStations: readonly string[],
): AnchorForSighting | null {
  if (segmentStations.length < 2) return null;
  const [station, next] = segmentStations;
  const direction = inferLegDirection(line, station, next);
  if (direction === null) return null;
  return { station, isUp: direction === 'up', segmentStations };
}

export interface PromotionFastForward {
  /** 앞에서부터 건너뛸 waypoint 수. */
  skip: number;
  /** 열차가 이미 지나친 환승/도착 waypoint가 있어 fast-forward를 포기한 경우 그 역명. */
  blockedAt?: string;
}

/**
 * 이미 앵커를 지난 열차를 sync로 lock할 때, 열차가 **이미 지난** 중간역 waypoint 수를 계산한다.
 * 그대로 두면 cron이 head를 따라잡으며(`estimateArrivalFromPosition` #2571) tick당 1역씩 늦은 매역 push를 쏜다.
 *
 *  - 열차가 구간 안 k번째 역에 sts=2(출발)이면 k까지, 그 외(진입/도착)면 k-1까지가 "지난 역"이다 —
 *    열차가 서 있는 역은 아직 지나지 않았으므로 그 역 알림은 정상 발사 대상으로 남긴다.
 *  - 지난 역에 환승/도착 waypoint가 하나라도 있으면 **아무것도 건너뛰지 않고** `blockedAt`을 보고한다
 *    (환승·도착은 건너뛰면 안 되고, 그 경우의 동작은 발명하지 않는다 — 호출부가 trip event로 남긴다).
 *  - 위치를 모르거나 앵커(idx 0)/앵커 이전이면 건너뛰지 않는다(#3056 신선 탭 동작 불변). 구간 밖이어도
 *    앵커 출발 기록(`passedAnchor`)이 있으면 현재 leg의 끝을 넘어선 열차로 보고 환승/도착 waypoint를 보고한다.
 */
export function planPromotionFastForward(
  waypoints: readonly Waypoint[],
  segmentStations: readonly string[],
  position: PositionEntry | undefined,
  passedAnchor = false,
): PromotionFastForward {
  if (!position) return { skip: 0 };
  const trainIdx = segmentStations.indexOf(position.stationName);
  // 구간 밖인데 앵커를 지난 기록이 있으면 현재 leg의 끝(환승/도착)을 넘어선 열차다 — 구간 전체가 "지난 역".
  if (trainIdx < 0 && !passedAnchor) return { skip: 0 };
  if (trainIdx === 0) return { skip: 0 };
  const passedIdx =
    trainIdx < 0
      ? Number.POSITIVE_INFINITY
      : position.trainSttus === TRAIN_STATUS.DEPARTED
        ? trainIdx
        : trainIdx - 1;
  let skip = 0;
  for (const waypoint of waypoints) {
    const idx = segmentStations.indexOf(waypoint.stationName);
    if (idx < 0 || idx > passedIdx) break;
    if (waypoint.kind !== 'intermediate') return { skip: 0, blockedAt: waypoint.stationName };
    skip += 1;
  }
  return { skip };
}

/**
 * trip의 현재 leg 앵커(환승 후면 currentLegAnchor, 아니면 promptDisplay)로 목록 앵커를 만든다. 도보 게이트는
 * 우회한다 — 환승 직후에도 사용자는 목록을 본다(171: 환승 45초 뒤 탭).
 */
export function resolveListAnchor(
  trip: Trip,
  now: number,
): (AnchorForSighting & { line: string }) | null {
  const origin = resolveActiveLegOrigin(trip, now, { allowLegTransfer: true, bypassWalkGate: true });
  if (!origin) return null;
  const leg = buildLegSegmentStations(trip.waypoints, origin.line);
  if (leg.length === 0) return null;
  const segment = leg[0] === origin.originStation ? leg : [origin.originStation, ...leg];
  const anchor = anchorFromSegment(origin.line, segment);
  return anchor ? { ...anchor, line: origin.line } : null;
}
