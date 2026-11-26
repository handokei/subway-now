import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { MAP_MODE_KEY } from '../../../shared/constants/storageKeys';

export type MapMode = 'map' | 'schematic';

const SCHEMATIC_MODE: MapMode = 'schematic';

/**
 * #3371 — 지도 탭 모드(지도 | 노선도) 저장·복원.
 * 로드 전·저장값 없음·웹은 지도 모드(기존 동작). 사용자가 로드 전에 전환했다면 저장값이 덮지 않는다.
 */
export function useMapMode() {
  const switchAvailable = Platform.OS !== 'web';
  const [stored, setStored] = useState<MapMode>('map');
  const [loaded, setLoaded] = useState(false);
  const touchedRef = useRef(false);

  useEffect(() => {
    AsyncStorage.getItem(MAP_MODE_KEY)
      .then((value) => {
        if (value === SCHEMATIC_MODE && !touchedRef.current) setStored(SCHEMATIC_MODE);
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  const setMode = useCallback((next: MapMode) => {
    touchedRef.current = true;
    setStored(next);
    AsyncStorage.setItem(MAP_MODE_KEY, next).catch(() => {});
  }, []);

  return { mode: switchAvailable ? stored : 'map', setMode, loaded, switchAvailable } as const;
}
