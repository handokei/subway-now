import { describe, expect, it } from 'vitest';
import { buildSilentPushData } from '../apns';
import {
  STATION_PUSH_WIRE_FIXTURE,
  STATION_PUSH_WIRE_FIXTURE_NO_STATION_ID,
} from '../../../../src/shared/types/__fixtures__/stationPushStationIdWireFixture';

/**
 * #3177 PR-9c — waypoint.stationId의 backend→device wire 계약(backend 측). 짝(device 소비)은 PR-11의
 * 단말 테스트가 같은 fixture를 import한다. fixture를 바꾸면 양쪽이 함께 깨진다(wire drift 차단).
 */
describe('#3177 — silent push data의 stationId wire 계약', () => {
  it('stationId가 있으면 data.stationId로 그대로 실린다(환승역은 fromLine 쪽 2-026)', () => {
    const data = buildSilentPushData({ ...STATION_PUSH_WIRE_FIXTURE });
    expect(data.stationId).toBe(STATION_PUSH_WIRE_FIXTURE.stationId);
    expect(data.nextWaypoint).toBe('사당');
  });

  it('stationId가 없으면 wire에 필드 자체가 없다(구 client byte-level 호환)', () => {
    const data = buildSilentPushData({ ...STATION_PUSH_WIRE_FIXTURE_NO_STATION_ID });
    expect(data).not.toHaveProperty('stationId');
  });
});
