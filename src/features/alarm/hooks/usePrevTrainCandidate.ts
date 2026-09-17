/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: 이 파일은 의도적으로 여러 features의 hook/util을 조합하는
 * orchestrator 역할이라 직접 import가 본질적이다. Phase 5 enforce 모드에서 file-level disable로
 * 옵트인 처리. 후속 PR(별도 이슈)에서 orchestration 슬라이스(예: features/fusion/, app shell)로
 * 추출하여 disable을 제거할 예정.
 *
 * ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" Phase 5 (#890).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { resolveTripDirection } from '../../route/utils/tripDirection';
import type { Route } from '../../../shared/utils/stationRoute';
import type { ArrivalInfo } from '../../../shared/types/arrival';
import type { LineNumber, Station } from '../../../shared/types/station';
import { PREV_TRAIN_CANDIDATE_BACKSTOP_MS } from '../../../shared/constants/eta';

export interface UsePrevTrainCandidateInputs {
  route: Route;
  destinationName: string | null;
  /** 출발역(사용자가 탑승할 역) — trip origin. */
  currentStation: Station | null;
  /** 출발역의 route 진행 방향 바로 다음 인접역 이름. */
  nextStationName: string | null;
  /** null이면(호선 미확정) 후보 산출 skip. */
  line: LineNumber | null;
  /** 출발역 도착 list — 여기서 사라지는(=출발하는) 전이를 관측해 전열차 후보를 판정한다. */
  currentArrivals: ArrivalInfo[];
}

export interface PrevTrainCandidate {
  train: ArrivalInfo;
  /** 출발역을 떠난 지 대략 몇 초 지났는지(전이 관측 시각부터 경과). */
  elapsedSeconds: number;
}

export interface UsePrevTrainCandidateResult {
  prevTrain: PrevTrainCandidate | null;
}

/** 만료 재평가 tick 간격(ms) — 후보가 존재하는 동안에만 이 주기로 elapsedSeconds를 갱신한다. */
const PREV_TRAIN_TICK_MS = 5_000;

interface SeenArrivals {
  contextKey: string;
  codes: Map<string, ArrivalInfo>;
}

interface DepartedCandidate {
  contextKey: string;
  train: ArrivalInfo;
  /** 이 열차가 currentArrivals에서 사라진(=출발한) 것을 관측한 시각. */
  detectedAtMs: number;
}

/**
 * "전열차"(출발역을 방금 떠난 열차) 후보 도출 — #2139, #2689.
 *
 * 판정 기준(#2689) — **전열차 후보 = 출발역 도착목록(`currentArrivals`)에서 가장 최근에 사라진
 * 열차.** 직전 tick의 `currentArrivals` trainCode 집합과 비교해, 이번 tick에 사라진 trainCode가
 * 있으면 그 열차를 "방금 출발한 열차"로 채택하고 이전 후보는 즉시 내려간다("다음 열차 출발 = 이전
 * 후보 교체"). 배차 간격이 2분이든 15분이든 시간 상수 없이 자동으로 맞는다(#2689 이전 구현은 고정
 * 5분 TTL이라 러시아워엔 과노출, 심야엔 조기 소멸했다).
 *
 * currentStation/nextStationName/line 중 하나라도 산출 불가하면 null(=UI가 기존 동작 유지).
 *
 * #2179 — 탑승한 열차가 다음 역마저 통과해 도착정보 API 응답에서 완전히 사라지는 경우도, 이 훅은애초에
 * "다음역 도착목록"이 아니라 "출발역 도착목록에서의 이탈"만 관측하므로 영향을 받지 않는다. 즉 다음
 * 역을 몇 개를 더 지나쳐도 "다음 열차가 아직 출발 전"이기만 하면 후보가 계속 탭 가능하다 — TTL로
 * 인위적으로 유지 기간을 늘렸던 구버전보다 오히려 더 정확한 acceptance를 만족한다.
 *
 * 안전 상한(backstop, `PREV_TRAIN_CANDIDATE_BACKSTOP_MS`) — 1차 기준이 아니라, 앱이 오래 백그라운드에
 * 있다가 돌아오는 등 이탈 전이 관측 자체를 놓친 경우에만 개입하는 최후 방어선이다. 근거는 상수 정의
 * 주석(`src/shared/constants/eta.ts`) 참조.
 *
 * 이탈 전이 관측은 순수 bookkeeping(`seenRef`)이라 렌더 중이 아니라 effect 안에서만 ref를 갱신한다.
 * 반면 실제 렌더 출력(`departed` 후보)은 state로 보관해 React 렌더 사이클과 일관되게 유지한다(#2656
 * 리뷰에서 지적된 "렌더 중 ref mutation 금지" 원칙을 계승 — 여기서는 ref가 렌더 출력에 직접 쓰이지
 * 않고 다음 tick과의 diff 재료로만 쓰이므로 안전하다).
 *
 * `now` tick(자체 interval, `PREV_TRAIN_TICK_MS` 간격)은 후보가 존재하는 동안에만 등록되고(#2656
 * 리뷰 — 후보가 없을 때 5초마다 리렌더를 만드는 건 순수 낭비이자 재렌더/발열 이슈(#2594)와 방향이
 * 어긋난다), 후보가 무효화되거나 backstop으로 만료되면 정지한다.
 */
export function usePrevTrainCandidate({
  route,
  destinationName,
  currentStation,
  nextStationName,
  line,
  currentArrivals,
}: UsePrevTrainCandidateInputs): UsePrevTrainCandidateResult {
  const direction = useMemo(() => {
    if (!route || !destinationName || !currentStation) return null;
    return resolveTripDirection(route, destinationName, currentStation.id);
  }, [route, destinationName, currentStation]);

  // #2656 리뷰 LOW-3 계승 — nextStationName을 key에 포함. origin/line/direction이 같아도 하류
  // 기준역(nextStationName)만 바뀌면 이전 후보는 다른 구간 기준으로 뽑힌 것이라 무효화해야 한다.
  const contextKey = `${currentStation?.id ?? ''}|${nextStationName ?? ''}|${line ?? ''}|${direction ?? ''}`;
  const isActive = Boolean(currentStation && nextStationName && line);

  const [departed, setDeparted] = useState<DepartedCandidate | null>(null);
  const [now, setNow] = useState<number>(() => Date.now());
  const seenRef = useRef<SeenArrivals | null>(null);

  // 이탈 전이 관측 — 직전 tick의 currentArrivals trainCode 집합과 비교해 사라진 열차를 채택한다.
  useEffect(() => {
    if (!isActive) {
      seenRef.current = null;
      setDeparted(null);
      return;
    }

    const nextCodes = new Map(currentArrivals.map((train) => [train.trainCode, train]));
    const prevSeen = seenRef.current;
    seenRef.current = { contextKey, codes: nextCodes };

    if (!prevSeen || prevSeen.contextKey !== contextKey) {
      // trip context(출발역+다음역+호선+방향) 변경 — 즉시 무효화하고 새 baseline부터 관측 시작.
      setDeparted(null);
      return;
    }

    const departedTrains = [...prevSeen.codes.keys()]
      .filter((code) => !nextCodes.has(code))
      .map((code) => prevSeen.codes.get(code) as ArrivalInfo);
    if (departedTrains.length === 0) return;

    // 폴링 간격이 배차보다 넓어 한 번에 여러 대가 사라졌다면, 마지막으로 도착 예정이었던(=arrivalSeconds
    // 최솟값) 열차가 가장 나중에 출발한 열차다 — 그 열차를 새 전열차 후보로 채택한다.
    const newest = departedTrains.reduce((min, cur) => (cur.arrivalSeconds < min.arrivalSeconds ? cur : min));
    setDeparted({ contextKey, train: newest, detectedAtMs: Date.now() });
  }, [currentArrivals, contextKey, isActive]);

  // backstop 만료 — 이게 있어야 아래 interval 게이팅이 "후보 없음"으로 판정해 tick을 멈출 수 있다.
  useEffect(() => {
    if (!departed) return;
    if (now - departed.detectedAtMs >= PREV_TRAIN_CANDIDATE_BACKSTOP_MS) {
      setDeparted(null);
    }
  }, [now, departed]);

  // 후보가 있을 때만 tick을 돌린다 — 없는데 5초마다 리렌더를 만드는 건 순수 낭비이고, 이 hook은
  // HomeScreen에서 2회 마운트되므로(prevTrain + transferPrevTrain) 상시 interval 2개를 추가하는
  // 셈 — 재렌더/발열 문제(#2594)와 방향이 어긋난다.
  const hasDeparted = departed !== null;
  useEffect(() => {
    if (!hasDeparted) return;
    const id = setInterval(() => setNow(Date.now()), PREV_TRAIN_TICK_MS);
    return () => clearInterval(id);
  }, [hasDeparted]);

  const prevTrain = useMemo<PrevTrainCandidate | null>(() => {
    if (!isActive || !departed || departed.contextKey !== contextKey) return null;
    const ageMs = now - departed.detectedAtMs;
    if (ageMs >= PREV_TRAIN_CANDIDATE_BACKSTOP_MS) return null;
    return { train: departed.train, elapsedSeconds: Math.floor(ageMs / 1000) };
  }, [isActive, departed, contextKey, now]);

  return { prevTrain };
}
