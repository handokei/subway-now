/* eslint-disable import/no-restricted-paths --
 * notifyTripEnded는 취침모드(settings 슬라이스) 여부를 읽는 cross-feature 모듈이라 테스트도 같은
 * settings store를 직접 세팅한다(`tripEndOffer.test.ts` 선례).
 */
/**
 * #2675 — 자동 trip 종료 알림.
 *
 * 사용자 보고(2026-09-17): "FG 진입하니 알아서 도착 후 종료돼 있음 — 도착 안내도 종료 알림도 없었다."
 * 종료 판정이 아니라 **알림 부재**가 결함이었다(문구는 i18n에 있었지만 소비처가 없었다).
 *
 * PR-3a(plan 2026-10-21 Part 3) — 조용한 종료 경로용 콘텐츠: 무음 배너 / data.kind+reason /
 * reason→i18n 데이터 맵 / 1 end = 1 notification claim / alarmLog 행.
 */
const mockSchedule = jest.fn().mockResolvedValue('id');
jest.mock('expo-notifications', () => ({
  scheduleNotificationAsync: (...args: unknown[]) => mockSchedule(...args),
}));
jest.mock('../../../../shared/infra/monitoring/breadcrumb', () => ({
  addDomainBreadcrumb: jest.fn(),
  // logger가 같은 모듈의 addLogBreadcrumb를 쓰므로 함께 채운다(부분 mock으로 깨지는 것 방지).
  addLogBreadcrumb: jest.fn(),
}));
const mockGetCorrId = jest.fn<string | null, []>();
jest.mock('../../../observability/utils/tripCorrId', () => ({
  getCurrentTripCorrIdSync: () => mockGetCorrId(),
}));
const mockGetStartedAt = jest.fn<Promise<number | null>, []>();
jest.mock('../tripStartStorage', () => ({ getTripStartedAt: () => mockGetStartedAt() }));
const mockGetItem = jest.fn<Promise<string | null>, [string]>();
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { getItem: (k: string) => mockGetItem(k) },
}));
const mockAppendAlarmLog = jest.fn();
jest.mock('../alarmLog', () => ({ appendAlarmLog: (e: unknown) => mockAppendAlarmLog(e) }));

import i18next from 'i18next';
import { Platform } from 'react-native';
import type { Station } from '../../../../shared/types/station';
import {
  notifyTripEnded,
  TRIP_ENDED_AUTO_KIND,
  TRIP_ENDED_NOTIFICATION_ID,
  TRIP_ENDED_TEXT_KEYS,
  type TripEndedReason,
} from '../tripEndedNotification';
import { TRIP_ENDED_CATEGORY } from '../notificationCategory';
import { __resetTripEndClaimsForTests__ } from '../tripEndClaim';
import { useSettingsStore } from '../../../settings/store/useSettingsStore';
import ko from '../../../../shared/i18n/locales/ko.json';
import en from '../../../../shared/i18n/locales/en.json';
import ja from '../../../../shared/i18n/locales/ja.json';
import zh from '../../../../shared/i18n/locales/zh.json';

const ttuksom: Station = {
  id: '2-010',
  name: '뚝섬',
  line: '2',
  lat: 37.547,
  lng: 127.047,
  lineColor: '#00A84D',
};

type Content = {
  title: string;
  body: string;
  sound: unknown;
  interruptionLevel?: string;
  data: { kind: string; reason: string; tripToken?: string };
};
const lastContent = (): Content =>
  mockSchedule.mock.calls[mockSchedule.mock.calls.length - 1][0].content;

const ALL_REASONS: TripEndedReason[] = [
  'arrived',
  'backstop',
  'paused',
  'lifecycle',
  'backend-gone',
  'backend-silent',
];

function resetAll(): void {
  jest.clearAllMocks();
  mockSchedule.mockResolvedValue('id');
  mockGetCorrId.mockReturnValue('corr-1');
  mockGetStartedAt.mockResolvedValue(1_700_000_000_000);
  mockGetItem.mockResolvedValue(null);
  __resetTripEndClaimsForTests__();
  useSettingsStore.setState({ sleepMode: false });
}

describe('notifyTripEnded (#2675)', () => {
  beforeEach(resetAll);

  it('도착 종료 — 목적지 도착 제목 + 역명이 실린 본문으로 로컬 알림을 띄운다', async () => {
    await notifyTripEnded({ destination: ttuksom, reason: 'arrived' });
    expect(mockSchedule).toHaveBeenCalledTimes(1);
    const arg = mockSchedule.mock.calls[0][0] as {
      identifier: string;
      content: { title: string; body: string; categoryIdentifier: string };
    };
    expect(arg.identifier).toBe(TRIP_ENDED_NOTIFICATION_ID);
    expect(arg.content.title).toBe(i18next.t('route.tripEndedArrivedTitle'));
    expect(arg.content.body).toContain('뚝섬');
    // [다음 여정 시작] 버튼이 붙도록 기존 category 재사용.
    expect(arg.content.categoryIdentifier).toBe(TRIP_ENDED_CATEGORY);
  });

  it('backstop 종료 — 도착이 아니므로 "안내 종료" 제목을 쓴다', async () => {
    await notifyTripEnded({ destination: ttuksom, reason: 'backstop' });
    const arg = mockSchedule.mock.calls[0][0] as { content: { title: string } };
    expect(arg.content.title).toBe(i18next.t('route.tripEndedTitle'));
  });

  it('destination이 없으면 역명 없이 종료 문구만', async () => {
    await notifyTripEnded({ destination: null, reason: 'arrived' });
    const arg = mockSchedule.mock.calls[0][0] as { content: { body: string } };
    expect(arg.content.body).toBe(i18next.t('route.tripEndedBody'));
  });

  it('알림 표시 실패는 swallow — 종료 cleanup 흐름을 막지 않는다', async () => {
    mockSchedule.mockRejectedValue(new Error('notification denied'));
    await expect(
      notifyTripEnded({ destination: ttuksom, reason: 'arrived' }),
    ).resolves.toBeUndefined();
  });
});

describe('notifyTripEnded — 조용한 종료 경로 콘텐츠 (PR-3a)', () => {
  beforeEach(resetAll);

  it.each(ALL_REASONS)('reason=%s — data.kind=trip-ended-auto + reason 값이 실린다', async (reason) => {
    await notifyTripEnded({ destination: null, reason });
    expect(lastContent().data).toEqual({ kind: TRIP_ENDED_AUTO_KIND, reason });
    expect(TRIP_ENDED_AUTO_KIND).toBe('trip-ended-auto');
  });

  it('호출부 보호 — claim 키 조회·문구 조립 단계가 throw해도 reject하지 않는다(종료 cleanup을 막지 않는다)', async () => {
    mockGetCorrId.mockImplementation(() => {
      throw new Error('corrId cache broken');
    });
    await expect(notifyTripEnded({ destination: null, reason: 'lifecycle' })).resolves.toBeUndefined();
    expect(mockSchedule).not.toHaveBeenCalled();
    mockGetCorrId.mockReturnValue('corr-1');
    const tSpy = jest.spyOn(i18next, 't').mockImplementation(() => {
      throw new Error('i18n broken');
    });
    try {
      await expect(notifyTripEnded({ destination: null, reason: 'lifecycle' })).resolves.toBeUndefined();
    } finally {
      tSpy.mockRestore();
    }
  });

  it('active trip 토큰이 있으면 data.tripToken에 싣는다', async () => {
    mockGetItem.mockResolvedValue('tok-abc');
    await notifyTripEnded({ destination: null, reason: 'lifecycle' });
    expect(lastContent().data.tripToken).toBe('tok-abc');
  });

  it('active trip 토큰 조회가 throw해도 알림은 나간다', async () => {
    mockGetItem.mockRejectedValue(new Error('storage down'));
    await notifyTripEnded({ destination: null, reason: 'lifecycle' });
    expect(mockSchedule).toHaveBeenCalledTimes(1);
    expect(lastContent().data.tripToken).toBeUndefined();
  });

  it('sound는 undefined가 아니라 명시 false다', async () => {
    await notifyTripEnded({ destination: null, reason: 'paused' });
    expect(Object.prototype.hasOwnProperty.call(lastContent(), 'sound')).toBe(true);
    expect(lastContent().sound).toBe(false);
  });

  it('interruption: 평상시 active, 취침모드 on이면 passive', async () => {
    await notifyTripEnded({ destination: null, reason: 'paused' });
    expect(lastContent().interruptionLevel).toBe('active');
    __resetTripEndClaimsForTests__();
    useSettingsStore.setState({ sleepMode: true });
    await notifyTripEnded({ destination: null, reason: 'paused' });
    expect(lastContent().interruptionLevel).toBe('passive');
  });

  it('비-iOS는 interruptionLevel 키를 싣지 않는다', async () => {
    const original = Platform.OS;
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
    try {
      await notifyTripEnded({ destination: null, reason: 'paused' });
      expect('interruptionLevel' in lastContent()).toBe(false);
    } finally {
      Object.defineProperty(Platform, 'OS', { value: original, configurable: true });
    }
  });

  it.each(ALL_REASONS)('reason=%s — 문구는 reason→i18n 데이터 맵을 따른다', async (reason) => {
    await notifyTripEnded({ destination: null, reason });
    const { title, body } = TRIP_ENDED_TEXT_KEYS[reason];
    expect(lastContent().title).toBe(i18next.t(title));
    expect(lastContent().body).toBe(i18next.t(body));
  });

  it('새 reason은 도착 문구를 재사용하지 않고, backend 두 reason만 문구를 공유한다', () => {
    expect(TRIP_ENDED_TEXT_KEYS.paused.body).not.toBe(TRIP_ENDED_TEXT_KEYS.arrived.body);
    expect(TRIP_ENDED_TEXT_KEYS.lifecycle.body).not.toBe(TRIP_ENDED_TEXT_KEYS.paused.body);
    expect(TRIP_ENDED_TEXT_KEYS['backend-gone'].body).toBe(
      TRIP_ENDED_TEXT_KEYS['backend-silent'].body,
    );
  });

  it.each([
    ['ko', ko],
    ['en', en],
    ['ja', ja],
    ['zh', zh],
  ])('%s 로케일에 reason 맵이 참조하는 모든 키가 비어있지 않게 존재한다', (_name, locale) => {
    const route = (locale as unknown as { route: Record<string, string> }).route;
    for (const reason of ALL_REASONS) {
      const { title, body } = TRIP_ENDED_TEXT_KEYS[reason];
      for (const key of [title, body]) {
        const leaf = key.replace(/^route\./, '');
        expect(typeof route[leaf]).toBe('string');
        expect(route[leaf].length).toBeGreaterThan(0);
      }
    }
  });

  describe('dedupe — 1 end = 1 notification', () => {
    it('같은 corrId로 동시에 두 경로가 불러도 1회만 표시한다', async () => {
      await Promise.all([
        notifyTripEnded({ destination: null, reason: 'lifecycle' }),
        notifyTripEnded({ destination: null, reason: 'backend-gone' }),
      ]);
      expect(mockSchedule).toHaveBeenCalledTimes(1);
    });

    it('corrId가 다르면(다른 트립) 각각 표시한다', async () => {
      mockGetCorrId.mockReturnValue('corr-1');
      await notifyTripEnded({ destination: null, reason: 'paused' });
      mockGetCorrId.mockReturnValue('corr-2');
      await notifyTripEnded({ destination: null, reason: 'paused' });
      expect(mockSchedule).toHaveBeenCalledTimes(2);
    });

    it('corrId가 없으면 startedAt 키로 dedupe한다', async () => {
      mockGetCorrId.mockReturnValue(null);
      await notifyTripEnded({ destination: null, reason: 'arrived' });
      await notifyTripEnded({ destination: null, reason: 'arrived' });
      expect(mockSchedule).toHaveBeenCalledTimes(1);
      mockGetStartedAt.mockResolvedValue(1_700_000_999_000);
      await notifyTripEnded({ destination: null, reason: 'arrived' });
      expect(mockSchedule).toHaveBeenCalledTimes(2);
    });

    it('corrId·startedAt 둘 다 없으면(cleanup 뒤 HomeScreen 호출) 분 단위 키로 dedupe한다', async () => {
      mockGetCorrId.mockReturnValue(null);
      mockGetStartedAt.mockResolvedValue(null);
      const base = 1_700_000_000_000;
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(base);
      try {
        await notifyTripEnded({ destination: null, reason: 'arrived' });
        await notifyTripEnded({ destination: null, reason: 'arrived' });
        expect(mockSchedule).toHaveBeenCalledTimes(1);
        nowSpy.mockReturnValue(base + 61_000);
        await notifyTripEnded({ destination: null, reason: 'arrived' });
        expect(mockSchedule).toHaveBeenCalledTimes(2);
      } finally {
        nowSpy.mockRestore();
      }
    });

    it('startedAt 조회가 throw해도 분 단위 키로 폴백하고 알림은 나간다', async () => {
      mockGetCorrId.mockReturnValue(null);
      mockGetStartedAt.mockRejectedValue(new Error('storage down'));
      await notifyTripEnded({ destination: null, reason: 'arrived' });
      expect(mockSchedule).toHaveBeenCalledTimes(1);
    });
  });

  describe('alarmLog 행', () => {
    it('표시 시 source=trip-end-notice 행을 reason과 함께 1건 적재한다', async () => {
      await notifyTripEnded({ destination: null, reason: 'lifecycle' });
      expect(mockAppendAlarmLog).toHaveBeenCalledTimes(1);
      expect(mockAppendAlarmLog.mock.calls[0][0]).toMatchObject({
        source: 'trip-end-notice',
        outcome: 'fired',
        reason: 'trip-end-notice',
        stationName: 'reason=lifecycle',
      });
    });

    it('dedupe로 건너뛴 호출은 행을 적재하지 않는다', async () => {
      await notifyTripEnded({ destination: null, reason: 'lifecycle' });
      await notifyTripEnded({ destination: null, reason: 'backend-gone' });
      expect(mockAppendAlarmLog).toHaveBeenCalledTimes(1);
    });

    it('알림 예약이 실패하면 행을 적재하지 않는다(표시된 적 없음)', async () => {
      mockSchedule.mockRejectedValue(new Error('denied'));
      await notifyTripEnded({ destination: null, reason: 'lifecycle' });
      expect(mockAppendAlarmLog).not.toHaveBeenCalled();
    });
  });
});
