import React from 'react';
import { waitFor } from '@testing-library/react-native';
import { StationExitCard } from '../StationExitCard';
import type { ExitInfoProvider } from '../../providers/types';
import type { ExitInfo } from '../../../../shared/types/exitInfo';
import { renderWithTheme } from '../../../../testUtils/renderWithTheme';

function makeProvider(exits: ExitInfo[]): ExitInfoProvider {
  return { getExits: jest.fn(async () => exits) };
}

const gangnamExits: ExitInfo[] = [
  { stationName: '강남', line: '2', exitNumber: '1', facilities: ['국기원', '강남구청'] },
  { stationName: '강남', line: '2', exitNumber: '6', facilities: ['교보타워'] },
  { stationName: '강남', line: '2', exitNumber: '10', facilities: ['뉴욕제과', '강남대로 버스환승센터'] },
];

describe('StationExitCard', () => {
  it('stationName이 null이면 null 반환 (렌더 없음)', () => {
    const provider = makeProvider(gangnamExits);
    const { queryByTestId } = renderWithTheme(
      <StationExitCard stationName={null} line="2" provider={provider} />,
    );
    expect(queryByTestId('station-exit-card')).toBeNull();
  });

  it('line이 null이면 null 반환 (렌더 없음)', () => {
    const provider = makeProvider(gangnamExits);
    const { queryByTestId } = renderWithTheme(
      <StationExitCard stationName="강남" line={null} provider={provider} />,
    );
    expect(queryByTestId('station-exit-card')).toBeNull();
  });

  it('데이터 로드 전(loading 상태)에는 카드가 숨겨진다', () => {
    let resolveFn: (v: ExitInfo[]) => void = () => undefined;
    const provider: ExitInfoProvider = {
      getExits: jest.fn(() => new Promise<ExitInfo[]>((resolve) => { resolveFn = resolve; })),
    };
    const { queryByTestId } = renderWithTheme(
      <StationExitCard stationName="강남" line="2" provider={provider} />,
    );
    // loading=true이고 아직 데이터 없음 → 카드 미렌더
    expect(queryByTestId('station-exit-card')).toBeNull();
    // cleanup promise
    resolveFn([]);
  });

  it('provider가 빈 배열을 반환하면 카드가 렌더되지 않는다 (graceful hide)', async () => {
    const provider = makeProvider([]);
    const { queryByTestId } = renderWithTheme(
      <StationExitCard stationName="강남" line="2" provider={provider} />,
    );
    await waitFor(() => {
      expect(provider.getExits).toHaveBeenCalledWith('강남', '2');
    });
    expect(queryByTestId('station-exit-card')).toBeNull();
  });

  it('provider 실패 시 카드가 렌더되지 않는다 (graceful hide)', async () => {
    const provider: ExitInfoProvider = {
      getExits: jest.fn(async () => { throw new Error('network'); }),
    };
    const { queryByTestId } = renderWithTheme(
      <StationExitCard stationName="강남" line="2" provider={provider} />,
    );
    await waitFor(() => {
      expect(provider.getExits).toHaveBeenCalled();
    });
    expect(queryByTestId('station-exit-card')).toBeNull();
  });

  it('출구 데이터가 있으면 카드가 렌더된다', async () => {
    const provider = makeProvider(gangnamExits);
    const { findByTestId, getByTestId } = renderWithTheme(
      <StationExitCard stationName="강남" line="2" provider={provider} />,
    );
    await findByTestId('station-exit-card');
    expect(getByTestId('station-exit-card-label')).toBeTruthy();
    expect(getByTestId('exit-row-1')).toBeTruthy();
    expect(getByTestId('exit-row-6')).toBeTruthy();
    expect(getByTestId('exit-row-10')).toBeTruthy();
  });

  it('각 출구의 번호와 시설 목록이 렌더된다', async () => {
    const provider = makeProvider(gangnamExits);
    const { findByTestId, getByText } = renderWithTheme(
      <StationExitCard stationName="강남" line="2" provider={provider} />,
    );
    await findByTestId('station-exit-card');
    expect(getByText('1번 출구')).toBeTruthy();
    expect(getByText('국기원 · 강남구청')).toBeTruthy();
    expect(getByText('6번 출구')).toBeTruthy();
    expect(getByText('교보타워')).toBeTruthy();
  });

  it('destination이 주어지면 매칭 출구가 앞에 렌더된다', async () => {
    const provider = makeProvider(gangnamExits);
    const { findByTestId, getAllByTestId } = renderWithTheme(
      <StationExitCard stationName="강남" line="2" destination="교보타워" provider={provider} />,
    );
    await findByTestId('station-exit-card');
    const rows = getAllByTestId(/^exit-row-/);
    // 교보타워가 있는 6번 출구가 첫 번째로 정렬된다
    expect(rows[0].props.testID).toBe('exit-row-6');
  });

  it('destination이 매칭 출구의 number 라벨은 accent 색을 반영한다(testID로 확인)', async () => {
    const provider = makeProvider(gangnamExits);
    const { findByTestId } = renderWithTheme(
      <StationExitCard stationName="강남" line="2" destination="교보타워" provider={provider} />,
    );
    await findByTestId('station-exit-card');
    // exit-number-6은 matchesDestination=true → accent 색 적용 testID 확인
    expect(await findByTestId('exit-number-6')).toBeTruthy();
  });

  it('destination이 없으면 원본 순서 유지', async () => {
    const provider = makeProvider(gangnamExits);
    const { findByTestId, getAllByTestId } = renderWithTheme(
      <StationExitCard stationName="강남" line="2" provider={provider} />,
    );
    await findByTestId('station-exit-card');
    const rows = getAllByTestId(/^exit-row-/);
    expect(rows[0].props.testID).toBe('exit-row-1');
    expect(rows[1].props.testID).toBe('exit-row-6');
    expect(rows[2].props.testID).toBe('exit-row-10');
  });

  it('stationName이 바뀌면 provider를 새로 호출한다', async () => {
    const provider = makeProvider(gangnamExits);
    const { findByTestId, rerender } = renderWithTheme(
      <StationExitCard stationName="강남" line="2" provider={provider} />,
    );
    await findByTestId('station-exit-card');
    rerender(<StationExitCard stationName="시청" line="1" provider={provider} />);
    await waitFor(() => {
      expect(provider.getExits).toHaveBeenCalledWith('시청', '1');
    });
  });

  it('기본 provider(MockExitInfoProvider)로도 동작 — 강남 2호선 샘플 데이터 반환', async () => {
    const { findByTestId } = renderWithTheme(
      <StationExitCard stationName="강남" line="2" />,
    );
    await findByTestId('station-exit-card');
  });
});
