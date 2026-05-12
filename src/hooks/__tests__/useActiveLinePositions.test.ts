import { renderHook } from '@testing-library/react-native';
import { useActiveLinePositions } from '../useActiveLinePositions';
import { useTrainPositions } from '../useTrainPositions';
import type { LinePositions } from '../../api/positionApi';

jest.mock('../useTrainPositions');

const mockUse = useTrainPositions as jest.Mock;

function positionRet(positions: LinePositions | null) {
  return { positions, loading: false, isMock: false };
}

describe('useActiveLinePositions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUse.mockReturnValue(positionRet(null));
  });

  it('빈 activeLines → 3개 슬롯 모두 null로 호출', () => {
    renderHook(() => useActiveLinePositions([]));
    expect(mockUse).toHaveBeenNthCalledWith(1, null, undefined);
    expect(mockUse).toHaveBeenNthCalledWith(2, null, undefined);
    expect(mockUse).toHaveBeenNthCalledWith(3, null, undefined);
  });

  it('activeLines K=3 슬롯에 라인 분배', () => {
    renderHook(() => useActiveLinePositions(['2', '3', '5']));
    expect(mockUse).toHaveBeenNthCalledWith(1, '2', undefined);
    expect(mockUse).toHaveBeenNthCalledWith(2, '3', undefined);
    expect(mockUse).toHaveBeenNthCalledWith(3, '5', undefined);
  });

  it('K보다 많은 activeLines는 잘라냄', () => {
    renderHook(() => useActiveLinePositions(['2', '3', '5', '7']));
    // 4번째 호선은 슬롯이 없어 useTrainPositions 호출 0회
    expect(mockUse).toHaveBeenCalledTimes(3);
  });

  it('각 슬롯의 positions를 배열로 반환', () => {
    const lp2: LinePositions = { line: '2', trains: [] };
    const lp3: LinePositions = { line: '3', trains: [] };
    mockUse
      .mockReturnValueOnce(positionRet(lp2))
      .mockReturnValueOnce(positionRet(lp3))
      .mockReturnValueOnce(positionRet(null));

    const { result } = renderHook(() => useActiveLinePositions(['2', '3']));
    expect(result.current).toEqual([lp2, lp3, null]);
  });

  it('provider 주입 시 그대로 useTrainPositions에 전달', () => {
    const provider = { getPositions: jest.fn() };
    renderHook(() => useActiveLinePositions(['2'], provider));
    expect(mockUse).toHaveBeenCalledWith('2', provider);
  });
});
