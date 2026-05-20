import React from 'react';
import { render } from '@testing-library/react-native';
import { TrainMarkerAnimated, TRAIN_TRANSITION_DURATION_MS } from '../TrainMarkerAnimated';
import type { TrainMarker } from '../../utils/findTrainCoordinates';
import { TRAIN_STATUS } from '../../constants/trainStatus';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  __animatedRegionTimingMock,
  __animatedRegionTimingStartMock,
} = require('react-native-maps');

beforeEach(() => {
  __animatedRegionTimingMock.mockClear();
  __animatedRegionTimingStartMock.mockClear();
});

function makeTrain(overrides: Partial<TrainMarker> = {}): TrainMarker {
  return {
    trainNo: '7355',
    line: '7',
    lineColor: '#747F00',
    lat: 37.5,
    lng: 127.0,
    statnNm: '강남구청',
    trainStatus: TRAIN_STATUS.DEPARTED,
    updnLine: 0,
    terminalStationName: '온수',
    ...overrides,
  };
}

describe('TrainMarkerAnimated', () => {
  it('초기 렌더 시 마커와 점이 표시된다', () => {
    const { getByTestId } = render(<TrainMarkerAnimated train={makeTrain()} />);
    expect(getByTestId('train-marker-7355')).toBeTruthy();
    expect(getByTestId('train-dot-7355')).toBeTruthy();
  });

  it('마운트 시 새 좌표로 timing 애니메이션을 1회 시작한다', () => {
    render(<TrainMarkerAnimated train={makeTrain()} />);
    expect(__animatedRegionTimingMock).toHaveBeenCalledTimes(1);
    expect(__animatedRegionTimingStartMock).toHaveBeenCalledTimes(1);
    expect(__animatedRegionTimingMock).toHaveBeenCalledWith(
      expect.objectContaining({
        latitude: 37.5,
        longitude: 127.0,
        duration: TRAIN_TRANSITION_DURATION_MS,
      }),
    );
  });

  it('좌표가 바뀌면 새 좌표로 다시 애니메이션이 시작된다', () => {
    const { rerender } = render(<TrainMarkerAnimated train={makeTrain()} />);
    __animatedRegionTimingMock.mockClear();
    __animatedRegionTimingStartMock.mockClear();
    rerender(<TrainMarkerAnimated train={makeTrain({ lat: 37.6, lng: 127.1 })} />);
    expect(__animatedRegionTimingMock).toHaveBeenCalledWith(
      expect.objectContaining({ latitude: 37.6, longitude: 127.1 }),
    );
    expect(__animatedRegionTimingStartMock).toHaveBeenCalledTimes(1);
  });

  it('좌표가 같으면 추가 애니메이션을 시작하지 않는다', () => {
    const train = makeTrain();
    const { rerender } = render(<TrainMarkerAnimated train={train} />);
    __animatedRegionTimingMock.mockClear();
    __animatedRegionTimingStartMock.mockClear();
    // trainStatus만 바꾸고 좌표는 동일
    rerender(<TrainMarkerAnimated train={{ ...train, trainStatus: TRAIN_STATUS.ARRIVED }} />);
    expect(__animatedRegionTimingMock).not.toHaveBeenCalled();
    expect(__animatedRegionTimingStartMock).not.toHaveBeenCalled();
  });

  it('trainStatus가 ARRIVED면 점이 노선 색으로 채워진다', () => {
    const { getByTestId } = render(
      <TrainMarkerAnimated train={makeTrain({ trainStatus: TRAIN_STATUS.ARRIVED })} />,
    );
    const dot = getByTestId('train-dot-7355');
    const flatStyle = Array.isArray(dot.props.style)
      ? Object.assign({}, ...dot.props.style)
      : dot.props.style;
    expect(flatStyle.backgroundColor).toBe('#747F00');
    expect(flatStyle.opacity).toBe(1);
  });

  it('trainStatus가 ENTERING이면 외곽선만, 그외는 흐림', () => {
    const { getByTestId, rerender } = render(
      <TrainMarkerAnimated train={makeTrain({ trainStatus: TRAIN_STATUS.ENTERING })} />,
    );
    let dot = getByTestId('train-dot-7355');
    let flat = Array.isArray(dot.props.style)
      ? Object.assign({}, ...dot.props.style)
      : dot.props.style;
    expect(flat.backgroundColor).toBe('transparent');
    expect(flat.opacity).toBe(0.85);

    rerender(<TrainMarkerAnimated train={makeTrain({ trainStatus: TRAIN_STATUS.DEPARTED })} />);
    dot = getByTestId('train-dot-7355');
    flat = Array.isArray(dot.props.style)
      ? Object.assign({}, ...dot.props.style)
      : dot.props.style;
    expect(flat.backgroundColor).toBe('transparent');
    expect(flat.opacity).toBe(0.5);
  });

  it('알 수 없는 trainStatus는 fallback 키로 처리된다', () => {
    const { getByTestId } = render(
      <TrainMarkerAnimated train={makeTrain({ trainStatus: 999 })} />,
    );
    expect(getByTestId('train-marker-7355')).toBeTruthy();
  });
});
