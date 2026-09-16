import { fireEvent } from '@testing-library/react-native';
import { Share } from 'react-native';
import { ShareTripButton } from '../ShareTripButton';
import { renderWithTheme } from '../../../../testUtils/renderWithTheme';
import type { DirectRoute, Route } from '../../../../shared/utils/stationRoute';
import type { Station } from '../../../../shared/types/station';

const directRoute: DirectRoute = {
  type: 'direct',
  stops: 5,
  line: '2',
  travelSeconds: 600,
};

function makeStation(overrides: Partial<Station> = {}): Station {
  return {
    id: '2-219',
    name: '강남',
    line: '2',
    lineColor: '#00A84D',
    lat: 37.4979,
    lng: 127.0276,
    ...overrides,
  };
}

describe('ShareTripButton', () => {
  beforeEach(() => {
    jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' } as never);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('필수 정보가 모두 있으면 버튼 렌더 + tap 시 Share.share 호출', () => {
    const { getByTestId } = renderWithTheme(
      <ShareTripButton
        route={directRoute}
        currentStation={makeStation()}
        destination={makeStation({ name: '잠실' })}
        totalStops={5}
        travelMinutes={10}
      />,
    );
    fireEvent.press(getByTestId('route-share-button'));
    expect(Share.share).toHaveBeenCalledTimes(1);
    const arg = (Share.share as jest.Mock).mock.calls[0][0];
    expect(typeof arg.message).toBe('string');
    expect(arg.message.length).toBeGreaterThan(0);
  });

  it('route가 없으면 null 렌더 + Share 미호출', () => {
    const { queryByTestId } = renderWithTheme(
      <ShareTripButton
        route={null as unknown as Route}
        currentStation={makeStation()}
        destination={makeStation({ name: '잠실' })}
        totalStops={5}
        travelMinutes={10}
      />,
    );
    expect(queryByTestId('route-share-button')).toBeNull();
    expect(Share.share).not.toHaveBeenCalled();
  });

  it('currentStation이 null이면 null 렌더', () => {
    const { queryByTestId } = renderWithTheme(
      <ShareTripButton
        route={directRoute}
        currentStation={null}
        destination={makeStation({ name: '잠실' })}
        totalStops={5}
        travelMinutes={10}
      />,
    );
    expect(queryByTestId('route-share-button')).toBeNull();
  });

  it('destination이 null이면 null 렌더', () => {
    const { queryByTestId } = renderWithTheme(
      <ShareTripButton
        route={directRoute}
        currentStation={makeStation()}
        destination={null}
        totalStops={5}
        travelMinutes={10}
      />,
    );
    expect(queryByTestId('route-share-button')).toBeNull();
  });

  it('커스텀 testID 적용', () => {
    const { getByTestId } = renderWithTheme(
      <ShareTripButton
        route={directRoute}
        currentStation={makeStation()}
        destination={makeStation({ name: '잠실' })}
        totalStops={5}
        travelMinutes={10}
        testID="custom-share"
      />,
    );
    expect(getByTestId('custom-share')).toBeTruthy();
  });
});
