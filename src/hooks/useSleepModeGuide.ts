import { useCallback, useEffect, useRef } from 'react';
import { Alert } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SLEEP_MODE_GUIDE_SHOWN_KEY } from '../constants/storageKeys';

export function useSleepModeGuide(): (onConfirm: () => void) => void {
  const shownRef = useRef(false);

  useEffect(() => {
    AsyncStorage.getItem(SLEEP_MODE_GUIDE_SHOWN_KEY).then((raw) => {
      shownRef.current = raw === 'true';
    }).catch(() => {});
  }, []);

  return useCallback((onConfirm: () => void) => {
    if (shownRef.current) {
      onConfirm();
      return;
    }
    shownRef.current = true;
    AsyncStorage.setItem(SLEEP_MODE_GUIDE_SHOWN_KEY, 'true').catch(() => {});
    Alert.alert(
      '취침 모드 안내',
      '이어폰이 연결되지 않은 경우 알람이 스피커로 재생될 수 있습니다.\n\n스피커 출력을 원하지 않으시면 설정 > 알람에서 \'스피커 출력 허용\'을 꺼주세요.',
      [{ text: '확인', onPress: onConfirm }],
    );
  }, []);
}
