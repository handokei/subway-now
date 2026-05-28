import { fireEvent } from '@testing-library/react-native';
import { MisBoardingReselectModal } from '../MisBoardingReselectModal';
import { renderWithTheme } from '../../testUtils/renderWithTheme';
import type { ArrivalInfo } from '../../api/arrivalApi';

function makeTrain(overrides: Partial<ArrivalInfo> = {}): ArrivalInfo {
  return {
    destination: '종착',
    arrivalMinutes: 3,
    arrivalSeconds: 180,
    statusMessage: '',
    trainCode: 'T-1',
    receivedAtMs: 0,
    arrivalCode: -1,
    isLastTrain: false,
    trainType: 'normal',
    ...overrides,
  };
}

describe('MisBoardingReselectModal', () => {
  it('visible=true + line 있으면 BoardingTrainList 렌더', () => {
    const { getByTestId, getByText } = renderWithTheme(
      <MisBoardingReselectModal
        visible
        arrivals={[makeTrain({ trainCode: 'A' })]}
        line="2"
        onSelect={() => {}}
        onClose={() => {}}
      />,
    );
    expect(getByTestId('mis-boarding-reselect-modal')).toBeTruthy();
    expect(getByText('탑승 열차 재선택')).toBeTruthy();
    expect(getByTestId('boarding-train-row-A')).toBeTruthy();
  });

  it('line=null이면 list 렌더 생략', () => {
    const { queryByTestId } = renderWithTheme(
      <MisBoardingReselectModal
        visible
        arrivals={[makeTrain()]}
        line={null}
        onSelect={() => {}}
        onClose={() => {}}
      />,
    );
    expect(queryByTestId('boarding-train-list')).toBeNull();
  });

  it('train 탭 시 onSelect에 train 전달', () => {
    const train = makeTrain({ trainCode: 'B' });
    const onSelect = jest.fn();
    const { getByTestId } = renderWithTheme(
      <MisBoardingReselectModal
        visible
        arrivals={[train]}
        line="2"
        onSelect={onSelect}
        onClose={() => {}}
      />,
    );
    fireEvent.press(getByTestId('boarding-train-row-B'));
    expect(onSelect).toHaveBeenCalledWith(train);
  });

  it('닫기 버튼 탭 시 onClose 호출', () => {
    const onClose = jest.fn();
    const { getByTestId } = renderWithTheme(
      <MisBoardingReselectModal
        visible
        arrivals={[makeTrain()]}
        line="2"
        onSelect={() => {}}
        onClose={onClose}
      />,
    );
    fireEvent.press(getByTestId('mis-boarding-reselect-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
