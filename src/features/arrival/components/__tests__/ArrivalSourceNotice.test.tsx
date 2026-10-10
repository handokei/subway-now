import { renderWithTheme } from '../../../../testUtils/renderWithTheme';
import { ArrivalSourceNotice, shouldHideArrivalEta } from '../ArrivalSourceNotice';
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

describe('shouldHideArrivalEta (#1922)', () => {
  // 사용자에게 ETA를 노출해도 되는지 판정. MOCK_ARRIVALS(source 미지정 + isMock=true)는 정적 데모값이라 ETA 자체 비공개.

  it('arrival이 null이면 ETA 숨김 (true)', () => {
    expect(shouldHideArrivalEta(null)).toBe(true);
  });

  it('source=realtime이면 ETA 노출 (false)', () => {
    expect(shouldHideArrivalEta({ ...base, source: 'realtime' })).toBe(false);
  });

  it('source=schedule이면 ETA 노출 (false) — wall-clock anchor라 정상 카운트다운', () => {
    expect(shouldHideArrivalEta({ ...base, source: 'schedule', isMock: true })).toBe(false);
  });

  it('source=closed면 ETA 숨김 (true) — 운행 종료', () => {
    expect(shouldHideArrivalEta({ ...base, source: 'closed', isMock: true })).toBe(true);
  });

  it('source 미지정 + isMock=true면 ETA 숨김 (true) — MOCK_ARRIVALS hardcoded', () => {
    expect(shouldHideArrivalEta({ ...base, isMock: true })).toBe(true);
  });

  it('source 미지정 + isMock=false면 ETA 노출 (false) — 기본 동작', () => {
    expect(shouldHideArrivalEta({ ...base })).toBe(false);
  });
});
