import { useCallback, useEffect, useRef } from 'react';
import { Alert } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useTranslation } from 'react-i18next';
import { SLEEP_MODE_GUIDE_SHOWN_KEY } from '../constants/storageKeys';

export function useSleepModeGuide(): (onConfirm: () => void) => void {
  const shownRef = useRef(false);
  const { t } = useTranslation();

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
      t('sleepModeGuide.title'),
      t('sleepModeGuide.message'),
      [{ text: t('sleepModeGuide.confirm'), onPress: onConfirm }],
    );
  }, [t]);
}
