import { useEffect, useState } from 'react';
import type { LineNumber } from '../../../shared/types/station';
import type { ExitInfo } from '../../../shared/types/exitInfo';
import type { ExitInfoProvider } from '../providers/types';
import { MockExitInfoProvider } from '../providers/MockExitInfoProvider';

const defaultProvider: ExitInfoProvider = new MockExitInfoProvider();

export interface RankedExit {
  exit: ExitInfo;
  /** destination 텍스트가 facilities 항목 중 하나에 substring으로 포함되면 true. */
  matchesDestination: boolean;
}

export interface UseStationExitsResult {
  exits: ExitInfo[];
  /**
   * destination이 주어졌을 때: 매칭 출구를 앞으로, 나머지는 기존 순서를 보존해 뒤로.
   * destination이 없으면 입력 순서 그대로.
   */
  ranked: RankedExit[];
  loading: boolean;
}

export interface UseStationExitsOptions {
  stationName: string | null;
  line: LineNumber | null;
  /** 사용자가 입력/선택한 도착 시설 텍스트. 없으면 ranking 없이 원본 순서. */
  destination?: string | null;
  /** 테스트/DI용. 미지정 시 MockExitInfoProvider 사용. */
  provider?: ExitInfoProvider;
}

function matches(facilities: string[], destination: string): boolean {
  const needle = destination.trim();
  if (needle.length === 0) return false;
  return facilities.some((facility) => facility.includes(needle));
}

/**
 * 현재 역의 출구 목록을 로드하고, destination 텍스트가 facilities에 포함되는 출구를
 * 앞쪽으로 정렬한 ranked 리스트를 함께 반환한다 (#1097 PoC).
 *
 * UI 진입(컴포넌트 wiring)은 follow-up. 본 hook은 데이터 계약 + ranking 정책의 단일 진입점.
 */
export function useStationExits({
  stationName,
  line,
  destination,
  provider = defaultProvider,
}: UseStationExitsOptions): UseStationExitsResult {
  const [exits, setExits] = useState<ExitInfo[]>([]);
  const [loading, setLoading] = useState<boolean>(false);

  useEffect(() => {
    if (!stationName || !line) {
      setExits([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    provider
      .getExits(stationName, line)
      .then((result) => {
        if (cancelled) return;
        setExits(result);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setExits([]);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [stationName, line, provider]);

  const ranked: RankedExit[] = (() => {
    const annotated = exits.map((exit) => ({
      exit,
      matchesDestination: destination
        ? matches(exit.facilities, destination)
        : false,
    }));
    if (!destination) return annotated;
    // stable partition: matches first, preserving original order in each group.
    return [
      ...annotated.filter((r) => r.matchesDestination),
      ...annotated.filter((r) => !r.matchesDestination),
    ];
  })();

  return { exits, ranked, loading };
}
