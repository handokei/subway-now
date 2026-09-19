import { describe, expect, it } from 'vitest';
import {
  APNS_COLLAPSE_ID_MAX_BYTES,
  BOARDING_PROMPT_COLLAPSE_ID_PREFIX,
  FALLBACK_ALERT_COLLAPSE_ID_PREFIX,
  PREPARE_ALARM_COLLAPSE_ID_PREFIX,
  SLEEP_ALARM_COLLAPSE_ID_PREFIX,
  STATION_NOTIF_COLLAPSE_ID_PREFIX,
  boardingPromptCollapseId,
  fallbackAlertCollapseId,
  prepareAlarmCollapseId,
  sleepAlarmCollapseId,
  stationNotifCollapseId,
  truncateUtf8,
} from '../collapseId';

// 코드리뷰(#2610 P1) 실측 최악 케이스 — 실존 역명 중 가장 긴 축에 속함.
const LONG_STATION_NAME = '남한산성입구(성남법원.검찰청)';
const HEX64_TOKEN =
  'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

describe('truncateUtf8 (#2610 코드리뷰 P1)', () => {
  it('한도 이하 문자열은 그대로 반환', () => {
    expect(truncateUtf8('강남', 64)).toBe('강남');
  });

  it('한도를 초과하면 UTF-8 바이트 기준으로 절단', () => {
    // '가'(3바이트) * 30 = 90바이트 > 64
    const input = '가'.repeat(30);
    const result = truncateUtf8(input, 64);
    expect(byteLength(result)).toBeLessThanOrEqual(64);
    expect(result.length).toBeLessThan(input.length);
  });

  it('멀티바이트 문자 중간에서 자르지 않는다 — 각 문자를 통째로 포함하거나 제외', () => {
    // 21글자 * 3바이트 = 63바이트(한도 이내), 22글자째부터 3바이트 추가하면 66 > 64라 제외돼야 함.
    const input = '가'.repeat(22);
    const result = truncateUtf8(input, 64);
    expect(result).toBe('가'.repeat(21));
    expect(byteLength(result)).toBe(63);
  });

  it('서러게이트 페어(이모지)를 쪼개지 않는다', () => {
    // 이모지(4바이트, 서러게이트 페어 2코드유닛)를 여러 개 붙여 한도 초과 유도.
    const input = '🚇'.repeat(20); // 4바이트 * 20 = 80바이트
    const result = truncateUtf8(input, 64);
    expect(byteLength(result)).toBeLessThanOrEqual(64);
    // 왕복 디코드가 실패(U+FFFD 없이 유효한 UTF-8)하지 않아야 한다 — 서러게이트 분리 시
    // encode 단계에서 각 코드포인트가 온전하지 않으면 아래가 깨진다.
    expect([...result].every((ch) => ch === '🚇')).toBe(true);
  });

  it('빈 문자열은 그대로 반환', () => {
    expect(truncateUtf8('', 64)).toBe('');
  });
});

describe('stationNotifCollapseId / boardingPromptCollapseId (station suffix 없음)', () => {
  it('짧은 mock token은 그대로 접두사+토큰', () => {
    expect(stationNotifCollapseId('lock-tok')).toBe(`${STATION_NOTIF_COLLAPSE_ID_PREFIX}lock-tok`);
    expect(boardingPromptCollapseId('bp-tok')).toBe(
      `${BOARDING_PROMPT_COLLAPSE_ID_PREFIX}bp-tok`,
    );
  });

  it('실물 길이(64 hex) device token은 16자로 축약되고 64B 이하', () => {
    const stationId = stationNotifCollapseId(HEX64_TOKEN);
    expect(stationId).toBe(`${STATION_NOTIF_COLLAPSE_ID_PREFIX}${HEX64_TOKEN.slice(0, 16)}`);
    expect(byteLength(stationId)).toBeLessThanOrEqual(APNS_COLLAPSE_ID_MAX_BYTES);

    const promptId = boardingPromptCollapseId(HEX64_TOKEN);
    expect(promptId).toBe(`${BOARDING_PROMPT_COLLAPSE_ID_PREFIX}${HEX64_TOKEN.slice(0, 16)}`);
    expect(byteLength(promptId)).toBeLessThanOrEqual(APNS_COLLAPSE_ID_MAX_BYTES);
  });
});

describe('sleepAlarmCollapseId / prepareAlarmCollapseId / fallbackAlertCollapseId (station suffix)', () => {
  it('짧은 역명은 절단 없이 그대로', () => {
    expect(sleepAlarmCollapseId('tok-abc', '군자')).toBe(
      `${SLEEP_ALARM_COLLAPSE_ID_PREFIX}tok-abc-군자`,
    );
    expect(prepareAlarmCollapseId('tok-abc', '군자')).toBe(
      `${PREPARE_ALARM_COLLAPSE_ID_PREFIX}tok-abc-군자`,
    );
    expect(fallbackAlertCollapseId('tok-abc', '군자')).toBe(
      `${FALLBACK_ALERT_COLLAPSE_ID_PREFIX}tok-abc-군자`,
    );
  });

  it('#2610 코드리뷰 실측 — 긴 한글 역명(64hex token 결합 시 65~74B)은 64B 이하로 절단', () => {
    const sleepId = sleepAlarmCollapseId(HEX64_TOKEN, LONG_STATION_NAME);
    const prepareId = prepareAlarmCollapseId(HEX64_TOKEN, LONG_STATION_NAME);
    const fallbackId = fallbackAlertCollapseId(HEX64_TOKEN, LONG_STATION_NAME);

    for (const id of [sleepId, prepareId, fallbackId]) {
      expect(byteLength(id)).toBeLessThanOrEqual(APNS_COLLAPSE_ID_MAX_BYTES);
    }
    // 절단이 실제로 station suffix에서 일어났는지 — 원본 미절단 문자열보다 짧아야 함.
    expect(sleepId.length).toBeLessThan(
      `${SLEEP_ALARM_COLLAPSE_ID_PREFIX}${HEX64_TOKEN.slice(0, 16)}-${LONG_STATION_NAME}`.length,
    );
  });

  it('prefix + tripToken(16자 축약)는 항상 예산 안에 들어와 station suffix만 절단 대상', () => {
    // prefix 최대 폭(boarding-prompt- 17자, 여기선 station suffix 빌더 중 fallback-alert- 15자)도
    // 16자 tripToken과 결합해도 64B에 크게 못 미친다 — station suffix가 없는 호출에서 절단 발생
    // 안 함을 별도로 검증(회귀 방지: 향후 prefix가 길어져도 tripToken 자체가 잘리면 안 됨).
    const id = fallbackAlertCollapseId(HEX64_TOKEN, '');
    expect(id).toBe(`${FALLBACK_ALERT_COLLAPSE_ID_PREFIX}${HEX64_TOKEN.slice(0, 16)}-`);
  });
});
