/**
 * #3155 — 앵커역 출발 열차 polling hook.
 *
 * 활성 trip 동안 backend `GET /trips/:token/anchor-departures`를 도착 목록과 같은 박자(30s)로 읽어
 * 목록의 "이미 출발" 섹션 원본(view)을 낸다. 한 번만 호출해 origin/transfer 두 슬롯이 공유한다
 * (슬롯별 필터는 `buildDepartedTrainRows`). 비활성/토큰·URL 부재/조회 실패는 전부 null — 섹션 없음.
 */
import { useCallback, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ACTIVE_TRIP_KEY } from '../../../shared/constants/storageKeys';
import { ANCHOR_DEPARTURES_POLL_MS } from '../../../shared/constants/departedTrains';
import { usePolling } from '../../../shared/hooks/usePolling';
import { fetchAnchorDepartures, type AnchorDeparturesView } from '../api/anchorDepartures';

export function useAnchorDepartures({ enabled }: { enabled: boolean }): AnchorDeparturesView | null {
  const [view, setView] = useState<AnchorDeparturesView | null>(null);

  const refresh = useCallback(async () => {
    const baseUrl = process.env.EXPO_PUBLIC_ALARM_BACKEND_URL;
    const tripToken = await AsyncStorage.getItem(ACTIVE_TRIP_KEY);
    if (!baseUrl || !tripToken) return;
    setView(await fetchAnchorDepartures(tripToken, baseUrl));
  }, []);

  // enabled가 꺼지면 이전 trip의 출발 열차가 남지 않게 비운다.
  useEffect(() => {
    if (!enabled) {
      setView(null);
      return;
    }
    void refresh();
  }, [enabled, refresh]);

  usePolling(() => {
    if (enabled) void refresh();
  }, ANCHOR_DEPARTURES_POLL_MS);

  return view;
}
