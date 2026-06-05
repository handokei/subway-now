import { renderWithTheme } from '../../../../testUtils/renderWithTheme';
import { ArrivalSourceNotice } from '../ArrivalSourceNotice';
import type { StationArrival } from '../../api/arrivalApi';

const base: StationArrival = { up: [], down: [] };

describe('ArrivalSourceNotice', () => {
  it('arrival이 null이면 아무것도 렌더하지 않는다', () => {
    const { toJSON, queryByTestId } = renderWithTheme(<ArrivalSourceNotice arrival={null} />);
    expect(toJSON()).toBeNull();
    expect(queryByTestId('arrival-schedule-notice')).toBeNull();
  });

  it('source가 realtime이면 아무것도 렌더하지 않는다', () => {
    const { toJSON } = renderWithTheme(
      <ArrivalSourceNotice arrival={{ ...base, source: 'realtime' }} />,
    );
    expect(toJSON()).toBeNull();
  });

  it('source가 closed면 closedNotice를 렌더', () => {
    const { getByTestId } = renderWithTheme(
      <ArrivalSourceNotice arrival={{ ...base, source: 'closed', isMock: true }} />,
    );
    expect(getByTestId('arrival-closed-notice')).toBeTruthy();
  });

  it('source가 schedule이면 scheduleNotice를 렌더', () => {
    const { getByTestId } = renderWithTheme(
      <ArrivalSourceNotice arrival={{ ...base, source: 'schedule', isMock: true }} />,
    );
    expect(getByTestId('arrival-schedule-notice')).toBeTruthy();
  });

  it('source 없고 isMock=true면 mockNotice를 렌더 (구버전 호환)', () => {
    const { getByTestId } = renderWithTheme(
      <ArrivalSourceNotice arrival={{ ...base, isMock: true }} />,
    );
    expect(getByTestId('arrival-mock-notice')).toBeTruthy();
  });
});
