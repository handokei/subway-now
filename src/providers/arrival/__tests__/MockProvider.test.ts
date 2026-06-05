import { MockArrivalProvider } from '../MockProvider';
import { MOCK_ARRIVALS } from '../../../api/arrivalApi';
import { SCHEDULE_FALLBACK_TRAIN_CODE_PREFIX } from '../../../features/alarm/utils/scheduleFallback';

describe('MockArrivalProvider', () => {
  let provider: MockArrivalProvider;

  // 시간표 lookup이 결정적으로 hit하도록 평일 출근 시간대(KST 09:00)로 시간 고정.
  const FIXED_KST_DATETIME = '2026-01-05T09:00:00+09:00';

  beforeEach(() => {
    provider = new MockArrivalProvider();
    jest.useFakeTimers().setSystemTime(new Date(FIXED_KST_DATETIME));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('lineHint와 알려진 역명을 받으면 schedule-based StationArrival 반환 (#805)', async () => {
    const result = await provider.getArrival('강남', { lineHint: '2' });
    // schedule-based 결과는 SCHED-* trainCode + isMock=false + source='schedule'.
    expect(result.isMock).toBe(false);
    expect(result.source).toBe('schedule');
    const allTrains = [...result.up, ...result.down];
    // 시간표 hit 시 최소 한 방향에는 train이 존재한다 (양방향 합산).
    expect(allTrains.length).toBeGreaterThan(0);
    for (const train of allTrains) {
      expect(train.trainCode.startsWith(SCHEDULE_FALLBACK_TRAIN_CODE_PREFIX)).toBe(true);
    }
  });

  it('lineHint 없이도 역명만으로 호선을 찾아 schedule-based 응답 (#805)', async () => {
    const result = await provider.getArrival('강남');
    // 강남은 stations.json에 2호선으로 등록되어 lookup 성공.
    expect(result.source).toBe('schedule');
  });

  it('알 수 없는 역명은 하드코딩 MOCK_ARRIVALS fallback (기존 동작 보존)', async () => {
    const result = await provider.getArrival('존재하지않는역');
    expect(result).toBe(MOCK_ARRIVALS);
  });

  it('빈 문자열 역명도 MOCK_ARRIVALS fallback', async () => {
    const result = await provider.getArrival('');
    expect(result).toBe(MOCK_ARRIVALS);
  });

  it('options.timeoutMs 같은 무관 옵션은 결과에 영향 없음', async () => {
    const result = await provider.getArrival('강남', { lineHint: '2', timeoutMs: 3000, maxPerDirection: 5 });
    expect(result.source).toBe('schedule');
    expect(Array.isArray(result.up)).toBe(true);
    expect(Array.isArray(result.down)).toBe(true);
  });

  it('options=undefined도 처리', async () => {
    const result = await provider.getArrival('강남', undefined);
    expect(result.source).toBe('schedule');
  });

  it('schedule 적중 결과는 arrivalSeconds가 양수인 결정적 trainCode 시퀀스', async () => {
    const result = await provider.getArrival('강남', { lineHint: '2' });
    const allTrains = [...result.up, ...result.down];
    for (const train of allTrains) {
      // 시간표 hit가 0초 트레인을 필터링하므로 arrivalSeconds > 0.
      expect(train.arrivalSeconds).toBeGreaterThan(0);
      // schedule fallback이 정해진 prefix + 방향+인덱스 suffix를 부여.
      expect(train.trainCode).toMatch(/^SCHED-(UP|DN)-\d+$/);
    }
  });
});
