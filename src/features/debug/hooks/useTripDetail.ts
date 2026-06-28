/**
 * #1956 (S-m3-1, Epic #1503) — TripDetailModal 데이터 조회 hook.
 *
 * tripToken을 받아 rawSignalBuffer SSOT에서 매칭 entries를 추출하고 buildTripDetail로
 * derived data를 만들어 반환한다. 매 rawSignalBuffer 변경 시 자동 re-render(subscribe).
 *
 * Wire:
 *   - tripToken=null → detail=null. caller(TripDetailModal)가 빈 본문 렌더 책임.
 *   - 매칭 entries 0건 → detail=null. 사용자가 modal을 열었을 때 "(no entries)" 표시.
 *
 * Re-render 정책 (rawSignalBuffer subscribe):
 *   매 push마다 store가 deps 변경 신호를 보내고, hook은 다시 buildTripDetail을 실행해
 *   최신 snapshot을 반환한다. fusion cycle(30s)마다 1회 push이므로 비용은 무시할 만함.
 */
import { useEffect, useState } from 'react';
import {
  getRawSignalEntries,
  subscribeRawSignal,
} from '../../observability/utils/rawSignalBuffer';
import { buildTripDetail, type TripDetail } from '../utils/buildTripDetail';

/**
 * tripToken과 매칭되는 trip detail snapshot을 반환.
 * rawSignalBuffer 변경 시 자동 갱신.
 */
export function useTripDetail(tripToken: string | null): TripDetail | null {
  const [detail, setDetail] = useState<TripDetail | null>(() =>
    buildTripDetail(getRawSignalEntries(), tripToken),
  );

  useEffect(() => {
    // tripToken 변경 시 즉시 재계산.
    setDetail(buildTripDetail(getRawSignalEntries(), tripToken));

    const unsubscribe = subscribeRawSignal(() => {
      setDetail(buildTripDetail(getRawSignalEntries(), tripToken));
    });
    return unsubscribe;
  }, [tripToken]);

  return detail;
}
