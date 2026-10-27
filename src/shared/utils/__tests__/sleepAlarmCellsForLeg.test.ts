/**
 * #3100 — 기기 안전망이 쓰는 leg별 칸 산출(`sleepAlarmCellsForLeg`).
 *
 * 정답지는 백엔드 판정이다: leg 길이 L의 첫 역(남은 수 L-1)부터 도착 직전(1)까지 한 칸씩 전진하며
 * 매 역 모드는 `selectSleepAlarmFire`, 선택 모드는 `selectedCellsDue` + 칸 선점으로 발사한 남은 수 목록.
 * 기기 칸 목록은 이 목록과 정확히 같아야 한다(출발역은 칸이 아니다).
 */
import {
  crossingForSingleAdvance,
  expandSleepAlarmStops,
  selectSleepAlarmFire,
  selectedCellsDue,
  sleepAlarmCellsForLeg,
} from '../sleepAlarmCells';
import {
  ONE_STATION_STEP,
  SLEEP_ALARM_MIN_STOPS_BEFORE,
  type SleepAlarmConfig,
} from '../../constants/sleepAlarm';

/** 백엔드 규칙을 그대로 따라 leg를 한 칸씩 전진시켜 발사된 남은 수 목록(내림차순)을 만든다. */
function backendFiredRemainings(config: SleepAlarmConfig | undefined, legStops: number): number[] {
  const fired: number[] = [];
  const claimed = new Set<number>();
  for (let remaining = legStops - ONE_STATION_STEP; remaining >= SLEEP_ALARM_MIN_STOPS_BEFORE; remaining -= 1) {
    const crossing = crossingForSingleAdvance(remaining);
    if (config?.mode === 'selected') {
      const due = selectedCellsDue(expandSleepAlarmStops(config), crossing).filter((cell) => !claimed.has(cell));
      due.forEach((cell) => claimed.add(cell));
      if (due.length > 0) fired.push(remaining);
    } else if (selectSleepAlarmFire(expandSleepAlarmStops(config), crossing) !== undefined) {
      fired.push(remaining);
    }
  }
  return fired;
}

const CONFIGS: { label: string; config: SleepAlarmConfig | undefined }[] = [
  { label: '기본', config: undefined },
  { label: '매 역 3', config: { mode: 'every', stops: [3] } },
  { label: '매 역 2', config: { mode: 'every', stops: [2] } },
  { label: '선택 {3}', config: { mode: 'selected', stops: [3] } },
  { label: '선택 {3,1}', config: { mode: 'selected', stops: [3, 1] } },
  { label: '선택 {3,2}', config: { mode: 'selected', stops: [3, 2] } },
];
const LEG_LENGTHS = [1, 2, 3, 4, 6];

describe('sleepAlarmCellsForLeg — 백엔드 발사 목록과 일치', () => {
  const cases = CONFIGS.flatMap(({ label, config }) =>
    LEG_LENGTHS.map((legStops) => ({ label, config, legStops })),
  );

  it.each(cases)('$label × L=$legStops', ({ config, legStops }) => {
    expect(sleepAlarmCellsForLeg(config, legStops)).toEqual(backendFiredRemainings(config, legStops));
  });
});

describe('sleepAlarmCellsForLeg — 대표 값 (사유 포함)', () => {
  it('선택 {3,1} × L=2: 출발역은 칸이 아니라 첫 역(1)으로 clamp되어 한 칸', () => {
    expect(sleepAlarmCellsForLeg({ mode: 'selected', stops: [3, 1] }, 2)).toEqual([1]);
  });

  it('선택 {3,2} × L=4: 3·2 두 칸', () => {
    expect(sleepAlarmCellsForLeg({ mode: 'selected', stops: [3, 2] }, 4)).toEqual([3, 2]);
  });

  it('매 역 3 × L=2: [3,2,1]이 전부 1로 clamp → 중복 제거 후 [1]', () => {
    expect(sleepAlarmCellsForLeg({ mode: 'every', stops: [3] }, 2)).toEqual([1]);
  });

  it('기본 × L=1: 칸 없음 (출발역 다음이 곧 도착역이라 1역 전이 성립하지 않는다)', () => {
    expect(sleepAlarmCellsForLeg(undefined, 1)).toEqual([]);
  });

  it('기본 × L≥2: 기본 칸 하나', () => {
    expect(sleepAlarmCellsForLeg(undefined, 5)).toEqual([SLEEP_ALARM_MIN_STOPS_BEFORE]);
  });
});
