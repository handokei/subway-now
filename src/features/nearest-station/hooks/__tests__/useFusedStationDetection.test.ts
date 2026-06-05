/**
 * #921 — useFusedStationDetection wire-up 테스트.
 *
 * 신호 변환(boolean/undefined → fusion 입력 키) + arvlcd 평가 분기 + verdict 결과를 검증.
 */
import { renderHook } from '@testing-library/react-native';
import {
  buildFusionSignalInput,
  evaluateArvlcdArrivedSignal,
  useFusedStationDetection,
  type FusedStationDetectionInput,
} from '../useFusedStationDetection';
import { ARRIVAL_CODE } from '../../../../shared/constants/arrivalCodes';
import type { ArrivalInfo, StationArrival } from '../../../../shared/types/arrival';

const TRAIN_CODE = 'T1234';

function arrivalRow(overrides: Partial<ArrivalInfo>): ArrivalInfo {
  return {
    destination: '왕십리',
    arrivalMinutes: 1,
    arrivalSeconds: 0,
    statusMessage: '',
    trainCode: TRAIN_CODE,
    line: '2',
    receivedAtMs: 0,
    arrivalCode: ARRIVAL_CODE.RUNNING,
    isLastTrain: false,
    trainType: 'normal',
    ...overrides,
  };
}

function arrival(up: ArrivalInfo[], down: ArrivalInfo[] = []): StationArrival {
  return { up, down };
}

const EMPTY_INPUT: FusedStationDetectionInput = {
  barometer: null,
  motionStationary: undefined,
  arrival: null,
  lockedTrainCode: null,
};

describe('evaluateArvlcdArrivedSignal', () => {
  it('arrival null → undefined (unavailable)', () => {
    expect(evaluateArvlcdArrivedSignal(null, TRAIN_CODE)).toBeUndefined();
  });

  it('lockedTrainCode null → undefined', () => {
    const a = arrival([arrivalRow({ arrivalCode: ARRIVAL_CODE.ARRIVED })]);
    expect(evaluateArvlcdArrivedSignal(a, null)).toBeUndefined();
  });

  it('lockedTrainCode undefined → undefined', () => {
    const a = arrival([arrivalRow({ arrivalCode: ARRIVAL_CODE.ARRIVED })]);
    expect(evaluateArvlcdArrivedSignal(a, undefined)).toBeUndefined();
  });

  it('row 매칭 없음 → undefined', () => {
    const a = arrival([arrivalRow({ trainCode: 'OTHER' })]);
    expect(evaluateArvlcdArrivedSignal(a, TRAIN_CODE)).toBeUndefined();
  });

  it.each([
    ['ARRIVED', ARRIVAL_CODE.ARRIVED],
    ['ENTERING', ARRIVAL_CODE.ENTERING],
  ])('arvlCd=%s → true', (_label, code) => {
    const a = arrival([arrivalRow({ arrivalCode: code })]);
    expect(evaluateArvlcdArrivedSignal(a, TRAIN_CODE)).toBe(true);
  });

  it.each([
    ['DEPARTED', ARRIVAL_CODE.DEPARTED],
    ['PREV_ARRIVED', ARRIVAL_CODE.PREV_ARRIVED],
    ['RUNNING', ARRIVAL_CODE.RUNNING],
  ])('arvlCd=%s → false (명시 미합의)', (_label, code) => {
    const a = arrival([arrivalRow({ arrivalCode: code })]);
    expect(evaluateArvlcdArrivedSignal(a, TRAIN_CODE)).toBe(false);
  });

  it('up과 down 모두 검색 — down에 매칭 row가 있어도 찾아냄', () => {
    const a = arrival(
      [arrivalRow({ trainCode: 'OTHER' })],
      [arrivalRow({ trainCode: TRAIN_CODE, arrivalCode: ARRIVAL_CODE.ARRIVED })],
    );
    expect(evaluateArvlcdArrivedSignal(a, TRAIN_CODE)).toBe(true);
  });
});

describe('buildFusionSignalInput', () => {
  it('모든 신호 unavailable → 빈 입력', () => {
    expect(buildFusionSignalInput(EMPTY_INPUT)).toEqual({});
  });

  it('barometer.stop=true 만 → barometer-stop=true', () => {
    const out = buildFusionSignalInput({
      ...EMPTY_INPUT,
      barometer: { subsurface: false, stop: true },
    });
    expect(out).toEqual({ 'barometer-stop': true });
  });

  it('barometer.stop=undefined → 키 생략', () => {
    const out = buildFusionSignalInput({
      ...EMPTY_INPUT,
      barometer: { subsurface: false, stop: undefined },
    });
    expect(out).toEqual({});
  });

  it('motionStationary=false → motion-stationary=false (명시 미합의로 입력)', () => {
    const out = buildFusionSignalInput({
      ...EMPTY_INPUT,
      motionStationary: false,
    });
    expect(out).toEqual({ 'motion-stationary': false });
  });

  it('arrival + lockedTrainCode + arvlCd=ARRIVED → arvlcd-arrived=true', () => {
    const a = arrival([arrivalRow({ arrivalCode: ARRIVAL_CODE.ARRIVED })]);
    const out = buildFusionSignalInput({
      ...EMPTY_INPUT,
      arrival: a,
      lockedTrainCode: TRAIN_CODE,
    });
    expect(out).toEqual({ 'arvlcd-arrived': true });
  });

  it('3 신호 모두 true → 3 키 모두 true', () => {
    const a = arrival([arrivalRow({ arrivalCode: ARRIVAL_CODE.ENTERING })]);
    const out = buildFusionSignalInput({
      barometer: { subsurface: false, stop: true },
      motionStationary: true,
      arrival: a,
      lockedTrainCode: TRAIN_CODE,
    });
    expect(out).toEqual({
      'barometer-stop': true,
      'motion-stationary': true,
      'arvlcd-arrived': true,
    });
  });
});

describe('useFusedStationDetection', () => {
  it('빈 입력 → detected=false low', () => {
    const { result } = renderHook(() => useFusedStationDetection(EMPTY_INPUT));
    expect(result.current.detected).toBe(false);
    expect(result.current.confidence).toBe('low');
    expect(result.current.signalsAgreed).toBe(0);
    expect(result.current.signalsAvailable).toBe(0);
  });

  it('1 신호만 합의 → detected=false low', () => {
    const { result } = renderHook(() =>
      useFusedStationDetection({
        ...EMPTY_INPUT,
        barometer: { subsurface: false, stop: true },
      }),
    );
    expect(result.current.detected).toBe(false);
    expect(result.current.signalsAgreed).toBe(1);
    expect(result.current.signalsAvailable).toBe(1);
  });

  it('2 신호 합의(barometer + motion) → detected medium', () => {
    const { result } = renderHook(() =>
      useFusedStationDetection({
        ...EMPTY_INPUT,
        barometer: { subsurface: false, stop: true },
        motionStationary: true,
      }),
    );
    expect(result.current.detected).toBe(true);
    expect(result.current.confidence).toBe('medium');
    expect(result.current.signalsAgreed).toBe(2);
  });

  it('3 신호 모두 합의 → detected high', () => {
    const a = arrival([arrivalRow({ arrivalCode: ARRIVAL_CODE.ARRIVED })]);
    const { result } = renderHook(() =>
      useFusedStationDetection({
        barometer: { subsurface: false, stop: true },
        motionStationary: true,
        arrival: a,
        lockedTrainCode: TRAIN_CODE,
      }),
    );
    expect(result.current.detected).toBe(true);
    expect(result.current.confidence).toBe('high');
    expect(result.current.signalsAgreed).toBe(3);
    expect(result.current.signalsAvailable).toBe(3);
  });

  it('같은 input reference로 재호출 시 verdict reference 동일 (useMemo)', () => {
    const input: FusedStationDetectionInput = {
      barometer: { subsurface: false, stop: true },
      motionStationary: true,
      arrival: null,
      lockedTrainCode: null,
    };
    const { result, rerender } = renderHook(
      ({ inp }: { inp: FusedStationDetectionInput }) =>
        useFusedStationDetection(inp),
      { initialProps: { inp: input } },
    );
    const first = result.current;
    rerender({ inp: input });
    expect(result.current).toBe(first);
  });
});
