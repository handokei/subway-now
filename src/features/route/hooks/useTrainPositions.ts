/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: 이 파일은 의도적으로 여러 features의 hook/util을 조합하는
 * orchestrator 역할이라 직접 import가 본질적이다. Phase 5 enforce 모드에서 file-level disable로
 * 옵트인 처리. 후속 PR(별도 이슈)에서 orchestration 슬라이스(예: features/fusion/, app shell)로
 * 추출하여 disable을 제거할 예정.
 *
 * ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" Phase 5 (#890).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { LinePositions } from '../../../shared/types/position';
import type { PositionProvider } from '../../../shared/types/providers';
import { createPositionProvider } from '../../nearest-station/providers/factory';
import { TtlCache } from '../../../shared/utils/ttlCache';
import { usePolling } from '../../../shared/hooks/usePolling';
import type { LineNumber } from '../../../shared/types/station';

const POLL_INTERVAL_MS = 5_000;
const CACHE_TTL_MS = 30_000;

/**
 * 모듈 스코프 싱글톤 — 같은 호선을 여러 hook 인스턴스가 폴링할 때 중복 호출 방지.
 * useArrivalInfo와 동일 패턴.
 */
const positionCache = new TtlCache<LineNumber, LinePositions>(CACHE_TTL_MS);

/** 테스트 격리용. */
export function __resetPositionCacheForTests(): void {
  positionCache.clear();
}

function positionsEqual(a: LinePositions | null, b: LinePositions): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

interface UseTrainPositionsReturn {
  positions: LinePositions | null;
  loading: boolean;
  isMock: boolean;
}

/**
 * 호선의 모든 운행 열차 위치를 폴링한다. line=null이면 비활성.
 * 사용자 GPS 후보의 호선들에 대해 Hook 여러 개 호출(Phase 3 useFusedNearestStation 패턴).
 */
export function useTrainPositions(
  line: LineNumber | null,
  provider?: PositionProvider,
): UseTrainPositionsReturn {
  const [positions, setPositions] = useState<LinePositions | null>(null);
  const [loading, setLoading] = useState(false);
  const providerRef = useRef<PositionProvider>(provider ?? createPositionProvider());
  const positionsRef = useRef<LinePositions | null>(null);
  const lineRef = useRef(line);
  lineRef.current = line;

  const update = useCallback((data: LinePositions) => {
    if (!positionsEqual(positionsRef.current, data)) {
      positionsRef.current = data;
      setPositions(data);
    }
  }, []);

  useEffect(() => {
    if (!line) {
      positionsRef.current = null;
      setPositions(null);
      setLoading(false);
      return;
    }

    const cached = positionCache.get(line);
    if (cached) {
      update(cached);
      setLoading(false);
    } else {
      positionsRef.current = null;
      setPositions(null);
      setLoading(true);
    }
  }, [line, update]);

  useEffect(() => {
    if (!line) return;

    let cancelled = false;
    const poll = async () => {
      try {
        const data = await providerRef.current.getPositions(line);
        if (cancelled) return;
        if (!data.isMock) positionCache.set(line, data);
        update(data);
      } catch {
        // Provider 내부에서 에러 처리
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    poll();
    return () => {
      cancelled = true;
    };
  }, [line, update]);

  usePolling(
    () => {
      const l = lineRef.current;
      if (!l) return;
      providerRef.current
        .getPositions(l)
        .then((data) => {
          if (l !== lineRef.current) return;
          if (!data.isMock) positionCache.set(l, data);
          update(data);
          setLoading(false);
        })
        .catch(() => {});
    },
    POLL_INTERVAL_MS,
    { onResume: () => positionCache.clear() },
  );

  return { positions, loading, isMock: positions?.isMock ?? false };
}
