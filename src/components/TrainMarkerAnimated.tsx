import React, { useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { MarkerAnimated, AnimatedRegion } from 'react-native-maps';
import type { TrainMarker as TrainMarkerData } from '../utils/findTrainCoordinates';
import { TRAIN_STATUS } from '../constants/trainStatus';

/**
 * 열차 마커. 좌표 변경(=새 폴링 도착) 시 짧은 트랜지션으로 새 위치까지 슬라이드한다.
 * 30초 동안 연속 슬라이드는 후속 이슈 #439에서 폴리라인 보간과 함께 처리.
 */
type StatusKey =
  | 'map.train.status.arrived'
  | 'map.train.status.entering'
  | 'map.train.status.departed'
  | 'map.train.status.prevDeparted'
  | 'map.train.status.running';

const TRAIN_STATUS_I18N_KEY: Record<number, StatusKey> = {
  [TRAIN_STATUS.ARRIVED]: 'map.train.status.arrived',
  [TRAIN_STATUS.ENTERING]: 'map.train.status.entering',
  [TRAIN_STATUS.DEPARTED]: 'map.train.status.departed',
  [TRAIN_STATUS.PREV_DEPARTED]: 'map.train.status.prevDeparted',
};
const TRAIN_STATUS_FALLBACK_KEY: StatusKey = 'map.train.status.running';

export const TRAIN_TRANSITION_DURATION_MS = 1000;

interface Props {
  readonly train: TrainMarkerData;
}

export function TrainMarkerAnimated({ train }: Props) {
  const { t } = useTranslation();
  const coord = useRef(
    new AnimatedRegion({
      latitude: train.lat,
      longitude: train.lng,
      latitudeDelta: 0,
      longitudeDelta: 0,
    }),
  ).current;

  useEffect(() => {
    // AnimatedRegion.timing은 toValue 없이 lat/lng 직접 머지하지만 TS 타입은
    // 기본 TimingAnimationConfig를 inherit해 toValue를 요구한다 (라이브러리 타입 보정 누락).
    const config = {
      latitude: train.lat,
      longitude: train.lng,
      latitudeDelta: 0,
      longitudeDelta: 0,
      duration: TRAIN_TRANSITION_DURATION_MS,
      useNativeDriver: false,
    } as unknown as Parameters<typeof coord.timing>[0];
    coord.timing(config).start();
  }, [train.lat, train.lng, coord]);

  const isArrived = train.trainStatus === TRAIN_STATUS.ARRIVED;
  const isEntering = train.trainStatus === TRAIN_STATUS.ENTERING;
  const opacity = isArrived ? 1 : isEntering ? 0.85 : 0.5;
  const statusKey = TRAIN_STATUS_I18N_KEY[train.trainStatus] ?? TRAIN_STATUS_FALLBACK_KEY;

  return (
    <MarkerAnimated
      coordinate={coord}
      title={t('map.train.terminalSuffix', { name: train.terminalStationName })}
      description={t('map.train.descriptionTemplate', {
        trainNo: train.trainNo,
        status: t(statusKey),
      })}
      tracksViewChanges={false}
      anchor={{ x: 0.5, y: 0.5 }}
      testID={`train-marker-${train.trainNo}`}
    >
      <View
        style={[
          styles.dot,
          {
            backgroundColor: isArrived ? train.lineColor : 'transparent',
            borderColor: train.lineColor,
            opacity,
          },
        ]}
        testID={`train-dot-${train.trainNo}`}
      />
    </MarkerAnimated>
  );
}

const styles = StyleSheet.create({
  dot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: 2,
  },
});
