import { describe, expect, it, vi } from 'vitest';
import {
  recordBoardingPromptOutcome,
  validateBoardingPromptOutcome,
} from '../boardingPromptOutcome';

describe('validateBoardingPromptOutcome', () => {
  it('accepts boarded outcome', () => {
    expect(
      validateBoardingPromptOutcome({ token: 'aabbccdd', outcome: 'boarded' }),
    ).toEqual({ token: 'aabbccdd', outcome: 'boarded' });
  });

  it('accepts dismissed outcome', () => {
    expect(
      validateBoardingPromptOutcome({ token: 'aabbccdd', outcome: 'dismissed' }),
    ).toEqual({ token: 'aabbccdd', outcome: 'dismissed' });
  });

  it('rejects non-object', () => {
    expect(validateBoardingPromptOutcome(null)).toBeNull();
    expect(validateBoardingPromptOutcome('x')).toBeNull();
  });

  it('rejects empty token', () => {
    expect(validateBoardingPromptOutcome({ token: '', outcome: 'boarded' })).toBeNull();
  });

  it('rejects missing token', () => {
    expect(validateBoardingPromptOutcome({ outcome: 'boarded' })).toBeNull();
  });

  it('rejects unknown outcome', () => {
    expect(
      validateBoardingPromptOutcome({ token: 'aabbccdd', outcome: 'bogus' }),
    ).toBeNull();
  });
});

describe('recordBoardingPromptOutcome', () => {
  it('writes total only when outcome is boarded (hit=0 skipped)', () => {
    const writer = { writeDataPoint: vi.fn() };
    recordBoardingPromptOutcome(writer, { token: 'aabbccdd1234', outcome: 'boarded' });
    expect(writer.writeDataPoint).toHaveBeenCalledTimes(1);
    const call = writer.writeDataPoint.mock.calls[0][0];
    expect(call.blobs[0]).toBe('phase3:boardingFalsePositiveRate:total');
    expect(call.doubles[0]).toBe(1);
  });

  it('writes hit + total when outcome is dismissed', () => {
    const writer = { writeDataPoint: vi.fn() };
    recordBoardingPromptOutcome(writer, { token: 'aabbccdd1234', outcome: 'dismissed' });
    expect(writer.writeDataPoint).toHaveBeenCalledTimes(2);
    const labels = writer.writeDataPoint.mock.calls.map((c) => c[0].blobs[0]);
    expect(labels).toContain('phase3:boardingFalsePositiveRate:hit');
    expect(labels).toContain('phase3:boardingFalsePositiveRate:total');
  });

  it('uses 8-char token prefix in indexes', () => {
    const writer = { writeDataPoint: vi.fn() };
    recordBoardingPromptOutcome(writer, { token: 'aabbccdd1234', outcome: 'dismissed' });
    const call = writer.writeDataPoint.mock.calls[0][0];
    expect(call.indexes[0]).toBe('aabbccdd');
    expect(call.blobs[1]).toBe('aabbccdd');
  });
});
