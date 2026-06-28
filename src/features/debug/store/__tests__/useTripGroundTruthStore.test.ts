import AsyncStorage from '@react-native-async-storage/async-storage';
import { TRIP_GROUND_TRUTH_KEY } from '../../../../shared/constants/storageKeys';
import { logGroundTruthResult } from '../../../alarm/utils/alarmLog';
import {
  RESPONSE_BUFFER_CAPACITY,
  getRecentResponses,
  getResponsesForCorrId,
  useTripGroundTruthStore,
} from '../useTripGroundTruthStore';

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
}));

// #1957 — store.respond가 backend metric forward 위해 logGroundTruthResult를 호출.
// 본 store unit test에서는 alarmLog 적재까지 검증하지 않고 호출 자체만 검증 (alarmLog 단위 테스트가 따로).
jest.mock('../../../alarm/utils/alarmLog', () => ({
  logGroundTruthResult: jest.fn(),
}));

const mockGetItem = AsyncStorage.getItem as jest.MockedFunction<typeof AsyncStorage.getItem>;
const mockSetItem = AsyncStorage.setItem as jest.MockedFunction<typeof AsyncStorage.setItem>;
const mockLogGroundTruthResult = logGroundTruthResult as jest.MockedFunction<typeof logGroundTruthResult>;

describe('useTripGroundTruthStore (#1502 M2)', () => {
  beforeEach(() => {
    useTripGroundTruthStore.setState({
      hydrated: false,
      pendingPrompt: null,
      responses: [],
    });
    mockGetItem.mockReset();
    mockSetItem.mockReset();
    mockSetItem.mockResolvedValue();
    mockLogGroundTruthResult.mockReset();
  });

  describe('enqueuePrompt', () => {
    it('pending이 없으면 새 prompt를 등록하고 persist한다', async () => {
      await useTripGroundTruthStore
        .getState()
        .enqueuePrompt({ corrId: 'c1', endedAt: 100 });
      expect(useTripGroundTruthStore.getState().pendingPrompt).toEqual({
        corrId: 'c1',
        endedAt: 100,
      });
      expect(useTripGroundTruthStore.getState().responses).toEqual([]);
      expect(mockSetItem).toHaveBeenCalledWith(
        TRIP_GROUND_TRUTH_KEY,
        expect.any(String),
      );
    });

    it('이전 pending이 미응답이면 unanswered로 합류시키고 새 prompt 등록', async () => {
      await useTripGroundTruthStore
        .getState()
        .enqueuePrompt({ corrId: 'c1', endedAt: 100 });
      await useTripGroundTruthStore
        .getState()
        .enqueuePrompt({ corrId: 'c2', endedAt: 200 });
      const state = useTripGroundTruthStore.getState();
      expect(state.pendingPrompt).toEqual({ corrId: 'c2', endedAt: 200 });
      expect(state.responses).toEqual([
        { corrId: 'c1', endedAt: 100, respondedAt: 200, outcome: 'unanswered' },
      ]);
    });

    it('persist 실패해도 메모리 상태는 갱신된다 (graceful)', async () => {
      mockSetItem.mockRejectedValueOnce(new Error('storage fail'));
      await useTripGroundTruthStore
        .getState()
        .enqueuePrompt({ corrId: 'c1', endedAt: 100 });
      expect(useTripGroundTruthStore.getState().pendingPrompt).toEqual({
        corrId: 'c1',
        endedAt: 100,
      });
    });
  });

  describe('respond', () => {
    it('pending이 없으면 graceful no-op', async () => {
      await useTripGroundTruthStore.getState().respond('accurate');
      expect(useTripGroundTruthStore.getState().responses).toEqual([]);
      expect(mockSetItem).not.toHaveBeenCalled();
    });

    it('accurate 응답을 합류하고 pending=null', async () => {
      jest.spyOn(Date, 'now').mockReturnValue(500);
      await useTripGroundTruthStore
        .getState()
        .enqueuePrompt({ corrId: 'c1', endedAt: 100 });
      await useTripGroundTruthStore.getState().respond('accurate');
      const state = useTripGroundTruthStore.getState();
      expect(state.pendingPrompt).toBeNull();
      expect(state.responses).toEqual([
        { corrId: 'c1', endedAt: 100, respondedAt: 500, outcome: 'accurate' },
      ]);
    });

    it('inaccurate / unanswered 모두 outcome 그대로 기록', async () => {
      jest.spyOn(Date, 'now').mockReturnValue(600);
      await useTripGroundTruthStore
        .getState()
        .enqueuePrompt({ corrId: 'c1', endedAt: 100 });
      await useTripGroundTruthStore.getState().respond('inaccurate');
      expect(useTripGroundTruthStore.getState().responses[0].outcome).toBe('inaccurate');

      await useTripGroundTruthStore
        .getState()
        .enqueuePrompt({ corrId: 'c2', endedAt: 200 });
      await useTripGroundTruthStore.getState().respond('unanswered');
      expect(useTripGroundTruthStore.getState().responses[1].outcome).toBe('unanswered');
    });

    // #1957 — backend algorithmAccuracyRatio metric wire
    it('#1957 — pending 있을 때 응답 시 logGroundTruthResult(corrId, outcome) 호출', async () => {
      await useTripGroundTruthStore
        .getState()
        .enqueuePrompt({ corrId: 'wire-c1', endedAt: 100 });
      await useTripGroundTruthStore.getState().respond('accurate');
      expect(mockLogGroundTruthResult).toHaveBeenCalledTimes(1);
      expect(mockLogGroundTruthResult).toHaveBeenCalledWith({
        corrId: 'wire-c1',
        outcome: 'accurate',
      });
    });

    it('#1957 — inaccurate / unanswered도 그대로 forward', async () => {
      await useTripGroundTruthStore
        .getState()
        .enqueuePrompt({ corrId: 'wire-c2', endedAt: 200 });
      await useTripGroundTruthStore.getState().respond('inaccurate');
      expect(mockLogGroundTruthResult).toHaveBeenLastCalledWith({
        corrId: 'wire-c2',
        outcome: 'inaccurate',
      });

      await useTripGroundTruthStore
        .getState()
        .enqueuePrompt({ corrId: 'wire-c3', endedAt: 300 });
      await useTripGroundTruthStore.getState().respond('unanswered');
      expect(mockLogGroundTruthResult).toHaveBeenLastCalledWith({
        corrId: 'wire-c3',
        outcome: 'unanswered',
      });
    });

    it('#1957 — pending 없을 때 응답 시 logGroundTruthResult 호출되지 않음', async () => {
      await useTripGroundTruthStore.getState().respond('accurate');
      expect(mockLogGroundTruthResult).not.toHaveBeenCalled();
    });

    it('ring buffer가 capacity를 넘으면 오래된 것부터 drop', async () => {
      // capacity + 2건을 한 번에 채워 trim 동작 검증.
      const responses = Array.from({ length: RESPONSE_BUFFER_CAPACITY + 2 }, (_, i) => ({
        corrId: `c${i}`,
        endedAt: i,
        respondedAt: i,
        outcome: 'accurate' as const,
      }));
      useTripGroundTruthStore.setState({ responses });
      await useTripGroundTruthStore
        .getState()
        .enqueuePrompt({ corrId: 'cnew', endedAt: 9999 });
      // 새 prompt enqueue는 trim을 트리거하지 않지만 이미 capacity 초과 상태 → respond에서 trim.
      jest.spyOn(Date, 'now').mockReturnValue(10000);
      await useTripGroundTruthStore.getState().respond('accurate');
      expect(useTripGroundTruthStore.getState().responses.length).toBe(
        RESPONSE_BUFFER_CAPACITY,
      );
      // 가장 오래된 c0/c1이 drop되었어야 한다.
      expect(useTripGroundTruthStore.getState().responses[0].corrId).not.toBe('c0');
    });
  });

  describe('hydrate', () => {
    it('storage가 비어있으면 hydrated=true만 set', async () => {
      mockGetItem.mockResolvedValue(null);
      await useTripGroundTruthStore.getState().hydrate();
      expect(useTripGroundTruthStore.getState().hydrated).toBe(true);
      expect(useTripGroundTruthStore.getState().pendingPrompt).toBeNull();
    });

    it('persist된 snapshot을 복원한다', async () => {
      mockGetItem.mockResolvedValue(
        JSON.stringify({
          pendingPrompt: { corrId: 'cp', endedAt: 11 },
          responses: [
            { corrId: 'cp', endedAt: 11, respondedAt: 12, outcome: 'accurate' },
          ],
        }),
      );
      await useTripGroundTruthStore.getState().hydrate();
      const state = useTripGroundTruthStore.getState();
      expect(state.hydrated).toBe(true);
      expect(state.pendingPrompt).toEqual({ corrId: 'cp', endedAt: 11 });
      expect(state.responses).toHaveLength(1);
    });

    it('JSON 손상 시 graceful — hydrated=true만 set', async () => {
      mockGetItem.mockResolvedValue('not-json');
      await useTripGroundTruthStore.getState().hydrate();
      expect(useTripGroundTruthStore.getState().hydrated).toBe(true);
    });

    it('responses가 배열이 아니면 빈 배열로 복구', async () => {
      mockGetItem.mockResolvedValue(
        JSON.stringify({ pendingPrompt: null, responses: 'broken' }),
      );
      await useTripGroundTruthStore.getState().hydrate();
      expect(useTripGroundTruthStore.getState().responses).toEqual([]);
    });

    it('storage 예외도 graceful', async () => {
      mockGetItem.mockRejectedValue(new Error('fail'));
      await useTripGroundTruthStore.getState().hydrate();
      expect(useTripGroundTruthStore.getState().hydrated).toBe(true);
    });
  });

  describe('read helpers', () => {
    it('getResponsesForCorrId: 해당 corrId만 필터', () => {
      useTripGroundTruthStore.setState({
        responses: [
          { corrId: 'a', endedAt: 1, respondedAt: 2, outcome: 'accurate' },
          { corrId: 'b', endedAt: 3, respondedAt: 4, outcome: 'inaccurate' },
          { corrId: 'a', endedAt: 5, respondedAt: 6, outcome: 'unanswered' },
        ],
      });
      expect(getResponsesForCorrId('a')).toHaveLength(2);
      expect(getResponsesForCorrId('z')).toEqual([]);
    });

    it('getRecentResponses: limit 0 또는 음수는 빈 배열', () => {
      useTripGroundTruthStore.setState({
        responses: [
          { corrId: 'a', endedAt: 1, respondedAt: 2, outcome: 'accurate' },
        ],
      });
      expect(getRecentResponses(0)).toEqual([]);
      expect(getRecentResponses(-5)).toEqual([]);
    });

    it('getRecentResponses: 직전 N건 반환', () => {
      const responses = Array.from({ length: 5 }, (_, i) => ({
        corrId: `c${i}`,
        endedAt: i,
        respondedAt: i,
        outcome: 'accurate' as const,
      }));
      useTripGroundTruthStore.setState({ responses });
      expect(getRecentResponses(2)).toEqual([
        { corrId: 'c3', endedAt: 3, respondedAt: 3, outcome: 'accurate' },
        { corrId: 'c4', endedAt: 4, respondedAt: 4, outcome: 'accurate' },
      ]);
    });
  });
});
