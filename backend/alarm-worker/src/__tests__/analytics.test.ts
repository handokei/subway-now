/**
 * Phase 0 측정 인프라 (#1577) — analytics.ts writeMetric() unit tests.
 *
 * Coverage:
 *  - binding 미바인딩 시 graceful no-op
 *  - 6 eventType 모두 동작
 *  - dimensions(blobs) / metrics(doubles) / indexes 매핑
 *  - optional 필드 (undefined skip)
 *  - tripToken 8자 prefix만 index에 forward
 */

import { describe, expect, it, vi } from 'vitest';
import { writeMetric, type TripMetricEventType } from '../analytics';
import type { AnalyticsEngineWriter, Env } from '../types';

function makeEnv(writer?: AnalyticsEngineWriter): Env {
  return {
    TRIPS: {} as KVNamespace,
    APNS_HOST: 'api.push.apple.com',
    APNS_HOST_SANDBOX: 'api.sandbox.push.apple.com',
    SEOUL_API_HOST: 'swopenapi.seoul.go.kr',
    SEOUL_API_KEY: 'k',
    APNS_KEY_ID: 'k',
    APNS_TEAM_ID: 't',
    APNS_PRIVATE_KEY: 'p',
    APNS_BUNDLE_ID: 'b',
    TRIP_METRICS: writer,
  };
}

describe('writeMetric — Phase 0 P0-1 (#1577)', () => {
  it('binding 미바인딩(env.TRIP_METRICS=undefined) → no-op', () => {
    const env = makeEnv(undefined);
    // 단순히 throw 안 하면 통과 — writer 호출 자체가 없어 spy 대상이 없다.
    expect(() =>
      writeMetric(env, {
        eventType: 'advance',
        tripToken: 'abcdef0123456789',
      }),
    ).not.toThrow();
  });

  it('eventType만 있는 minimal event도 blobs/indexes는 forward', () => {
    const writeDataPoint = vi.fn();
    const env = makeEnv({ writeDataPoint });
    writeMetric(env, {
      eventType: 'trip-mutation',
      tripToken: 'deadbeefcafe0000',
    });
    expect(writeDataPoint).toHaveBeenCalledTimes(1);
    const arg = writeDataPoint.mock.calls[0][0];
    expect(arg.blobs).toEqual(['trip-mutation']);
    expect(arg.doubles).toEqual([]);
    expect(arg.indexes).toEqual(['deadbeef']);
  });

  it('full event — dimensions / metrics 모두 매핑', () => {
    const writeDataPoint = vi.fn();
    const env = makeEnv({ writeDataPoint });
    writeMetric(env, {
      eventType: 'fire',
      tripToken: '0123456789abcdef',
      stationId: '강남',
      reason: 'arvlcd:intermediate',
      environment: 'underground',
      staleMs: 12345,
      hopIndex: 3,
      motionConfidence: 0.8,
    });
    const arg = writeDataPoint.mock.calls[0][0];
    expect(arg.blobs).toEqual([
      'fire',
      'station:강남',
      'reason:arvlcd:intermediate',
      'env:underground',
    ]);
    expect(arg.doubles).toEqual([12345, 3, 0.8]);
    expect(arg.indexes).toEqual(['01234567']);
  });

  it('optional double 필드 일부만 있어도 doubles에 순서대로 push', () => {
    const writeDataPoint = vi.fn();
    const env = makeEnv({ writeDataPoint });
    writeMetric(env, {
      eventType: 'suppress',
      tripToken: 'tok12345extra',
      hopIndex: 7,
    });
    const arg = writeDataPoint.mock.calls[0][0];
    expect(arg.doubles).toEqual([7]);
    expect(arg.blobs).toEqual(['suppress']);
  });

  it('6 eventType 모두 적재 가능 (V/X event 어휘 완전성)', () => {
    const writeDataPoint = vi.fn();
    const env = makeEnv({ writeDataPoint });
    const eventTypes: TripMetricEventType[] = [
      'advance',
      'fire',
      'suppress',
      'motion-transition',
      'position-upload',
      'trip-mutation',
    ];
    for (const eventType of eventTypes) {
      writeMetric(env, { eventType, tripToken: 'token0001abcdef' });
    }
    expect(writeDataPoint).toHaveBeenCalledTimes(eventTypes.length);
    eventTypes.forEach((eventType, i) => {
      expect(writeDataPoint.mock.calls[i][0].blobs[0]).toBe(eventType);
    });
  });

  it('tripToken 8자 미만이어도 그대로 index에 forward (privacy: prefix만)', () => {
    const writeDataPoint = vi.fn();
    const env = makeEnv({ writeDataPoint });
    writeMetric(env, { eventType: 'advance', tripToken: 'short' });
    expect(writeDataPoint.mock.calls[0][0].indexes).toEqual(['short']);
  });
});
