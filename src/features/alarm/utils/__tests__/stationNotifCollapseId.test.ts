import { buildStationNotifCollapseId, STATION_NOTIF_COLLAPSE_ID_PREFIX } from '../stationNotifCollapseId';

// #2122 — backend `stationNotifCollapseId`(backend/alarm-worker/src/scheduled.ts, #2063/#2086)의
// 실제 테스트에서 사용하는 HEX64_TOKEN 리터럴을 그대로 재사용해, device-side 구현이 backend
// 규칙과 문자열 단위로 동일한 출력을 내는지 byte-for-byte 검증한다.
// backend/alarm-worker/src/__tests__/scheduled.test.ts:88 참고.
const HEX64_TOKEN = '0123456789abcdef'.repeat(4);

describe('buildStationNotifCollapseId (#2122)', () => {
  it('STATION_NOTIF_COLLAPSE_ID_PREFIX(station-) + device token slice(0,16)로 빌드한다', () => {
    expect(buildStationNotifCollapseId(HEX64_TOKEN)).toBe(
      `${STATION_NOTIF_COLLAPSE_ID_PREFIX}${HEX64_TOKEN.slice(0, 16)}`,
    );
  });

  it('backend stationNotifCollapseId(#2063/#2086)와 문자열 단위로 동일한 출력 — 64 hex 토큰 → station-<16hex>', () => {
    expect(buildStationNotifCollapseId(HEX64_TOKEN)).toBe('station-0123456789abcdef');
  });

  it('64B 이하 — apns-collapse-id 한도 준수', () => {
    const collapseId = buildStationNotifCollapseId(HEX64_TOKEN);
    expect(new TextEncoder().encode(collapseId).length).toBeLessThanOrEqual(64);
  });

  it('짧은 mock token(slice가 no-op)도 안전하게 처리한다', () => {
    expect(buildStationNotifCollapseId('short-tok')).toBe('station-short-tok');
  });
});
