import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  SSOT_MIRROR_STALE_MS,
  createNotificationRouter,
  type RouterSsotMirror,
  type RouterSurfaceFns,
} from '../infra/NotificationRouterImpl';
import {
  __resetDeliveryLogForTest,
  getDeliveryEntries,
} from '../store/notificationDeliveryLog';
import type {
  DeliveryRequest,
  NotificationSurface,
} from '../ports/NotificationRouter';

jest.mock('@react-native-async-storage/async-storage', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

function makeReq(
  overrides: Partial<DeliveryRequest> = {},
): DeliveryRequest {
  return {
    alarmId: 'a-1',
    eventKey: 'station-passed:중곡',
    surface: 'banner',
    content: { title: 'T', body: 'B' },
    source: 'bg-silent-push',
    ...overrides,
  };
}

interface CountingSurfaces extends RouterSurfaceFns {
  bannerCalls: number;
  liveActivityCalls: number;
  widgetCalls: number;
  inAppCalls: number;
  clearAllCalls: number;
}

function makeSurfaces(): CountingSurfaces {
  // 한 객체에 counts + 함수를 함께 담아 클로저가 같은 인스턴스를 mutate하도록.
  const s = {
    bannerCalls: 0,
    liveActivityCalls: 0,
    widgetCalls: 0,
    inAppCalls: 0,
    clearAllCalls: 0,
    banner: () => {
      s.bannerCalls += 1;
    },
    liveActivity: () => {
      s.liveActivityCalls += 1;
    },
    widget: () => {
      s.widgetCalls += 1;
    },
    inApp: () => {
      s.inAppCalls += 1;
    },
    clearAll: () => {
      s.clearAllCalls += 1;
    },
  } as CountingSurfaces;
  return s;
}

describe('NotificationRouter (#1575 T12)', () => {
  beforeEach(async () => {
    __resetDeliveryLogForTest();
    await AsyncStorage.clear();
  });

  describe('dedup (alarmId, surface) matrix', () => {
    it('same alarmId + same surface twice → first deliver, second suppress', async () => {
      const surfaces = makeSurfaces();
      const router = createNotificationRouter({
        surfaces,
        readSsotMirror: async () => null,
      });

      const first = await router.deliver(makeReq());
      const second = await router.deliver(makeReq());

      expect(first.delivered).toBe(true);
      expect(second.delivered).toBe(false);
      expect(second.reason).toBe('dedup-same-surface');
      expect(surfaces.bannerCalls).toBe(1);
    });

    it('same alarmId × 4 different surfaces → all delivered (multi-surface intent)', async () => {
      const surfaces = makeSurfaces();
      const router = createNotificationRouter({
        surfaces,
        readSsotMirror: async () => null,
      });

      const fanOut: NotificationSurface[] = [
        'banner',
        'live-activity',
        'widget',
        'in-app',
      ];
      const results = await Promise.all(
        fanOut.map((surface) => router.deliver(makeReq({ surface }))),
      );

      expect(results.every((r) => r.delivered)).toBe(true);
      expect(surfaces.bannerCalls).toBe(1);
      expect(surfaces.liveActivityCalls).toBe(1);
      expect(surfaces.widgetCalls).toBe(1);
      expect(surfaces.inAppCalls).toBe(1);
    });
  });

  describe('backend SSoT mirror gate', () => {
    it('mirror fresh + stationId in passedStations → reject', async () => {
      const surfaces = makeSurfaces();
      const mirror: RouterSsotMirror = {
        passedStations: ['0228'],
        receivedAt: Date.now(),
      };
      const router = createNotificationRouter({
        surfaces,
        readSsotMirror: async () => mirror,
      });

      const result = await router.deliver(
        makeReq({ content: { title: 'T', body: 'B', data: { stationId: '0228' } } }),
      );

      expect(result.delivered).toBe(false);
      expect(result.reason).toBe('gate-station-already-passed');
      expect(surfaces.bannerCalls).toBe(0);
    });

    it('mirror fresh + stationId NOT in passedStations → deliver', async () => {
      const surfaces = makeSurfaces();
      const router = createNotificationRouter({
        surfaces,
        readSsotMirror: async () => ({
          passedStations: ['0220'],
          receivedAt: Date.now(),
        }),
      });
      const result = await router.deliver(
        makeReq({ content: { title: 'T', body: 'B', data: { stationId: '0228' } } }),
      );
      expect(result.delivered).toBe(true);
    });

    it('mirror stale (>5min) → gate auto-pass even if stationId in passedStations', async () => {
      const surfaces = makeSurfaces();
      const router = createNotificationRouter({
        surfaces,
        readSsotMirror: async () => ({
          passedStations: ['0228'],
          receivedAt: Date.now() - SSOT_MIRROR_STALE_MS - 1_000,
        }),
      });
      const result = await router.deliver(
        makeReq({ content: { title: 'T', body: 'B', data: { stationId: '0228' } } }),
      );
      expect(result.delivered).toBe(true);
    });

    it('mirror null (T8 이전 backend) → gate auto-pass', async () => {
      const surfaces = makeSurfaces();
      const router = createNotificationRouter({
        surfaces,
        readSsotMirror: async () => null,
      });
      const result = await router.deliver(makeReq());
      expect(result.delivered).toBe(true);
    });

    it('mirror fresh but stationId undefined in content.data → gate skipped (no false reject)', async () => {
      const surfaces = makeSurfaces();
      const router = createNotificationRouter({
        surfaces,
        readSsotMirror: async () => ({
          passedStations: ['0228'],
          receivedAt: Date.now(),
        }),
      });
      // content.data 없음 = stationId 없음 → router는 검증 skip.
      const result = await router.deliver(makeReq());
      expect(result.delivered).toBe(true);
    });
  });

  describe('sleep mode gate', () => {
    it('sleepMode ON + sleepRuleEligible true → reject', async () => {
      const surfaces = makeSurfaces();
      const router = createNotificationRouter({
        surfaces,
        readSsotMirror: async () => null,
      });
      const result = await router.deliver(
        makeReq({ sleepMode: true, sleepRuleEligible: true }),
      );
      expect(result.delivered).toBe(false);
      expect(result.reason).toBe('gate-sleep-mode-blocked');
    });

    it('sleepMode ON + sleepRuleEligible false → deliver (destination 보호)', async () => {
      const surfaces = makeSurfaces();
      const router = createNotificationRouter({
        surfaces,
        readSsotMirror: async () => null,
      });
      const result = await router.deliver(
        makeReq({ sleepMode: true, sleepRuleEligible: false }),
      );
      expect(result.delivered).toBe(true);
    });

    it('sleepMode OFF + sleepRuleEligible true → deliver', async () => {
      const surfaces = makeSurfaces();
      const router = createNotificationRouter({
        surfaces,
        readSsotMirror: async () => null,
      });
      const result = await router.deliver(
        makeReq({ sleepMode: false, sleepRuleEligible: true }),
      );
      expect(result.delivered).toBe(true);
    });
  });

  describe('delivery log recording', () => {
    it('every deliver/suppress is logged with surface + source + reason', async () => {
      const router = createNotificationRouter({
        surfaces: makeSurfaces(),
        readSsotMirror: async () => null,
      });
      await router.deliver(makeReq({ alarmId: 'a-1' }));
      await router.deliver(makeReq({ alarmId: 'a-1' })); // dedup suppress

      const entries = getDeliveryEntries();
      expect(entries).toHaveLength(2);
      expect(entries[0]?.result).toBe('delivered');
      expect(entries[1]?.result).toBe('suppressed');
      expect(entries[1]?.reason).toBe('dedup-same-surface');
    });
  });

  describe('surface dispatch resilience', () => {
    it('surface function throwing does not propagate — logged as delivered (호출 시도 발생)', async () => {
      const router = createNotificationRouter({
        surfaces: {
          banner: () => {
            throw new Error('expo notif failed');
          },
          liveActivity: () => undefined,
          widget: () => undefined,
          inApp: () => undefined,
        },
        readSsotMirror: async () => null,
      });
      const result = await router.deliver(makeReq());
      expect(result.delivered).toBe(true);
      // 후속 PR에서 'failed' result + retry queue 도입 예정 (PR body Risk #4 참고).
    });

    it('async surface function rejection is swallowed', async () => {
      const router = createNotificationRouter({
        surfaces: {
          banner: async () => {
            throw new Error('async fail');
          },
          liveActivity: () => undefined,
          widget: () => undefined,
          inApp: () => undefined,
        },
        readSsotMirror: async () => null,
      });
      await expect(router.deliver(makeReq())).resolves.toMatchObject({
        delivered: true,
      });
    });
  });

  describe('clearAllForTrip', () => {
    it('resets dedup map + delivery log + invokes surfaces.clearAll', async () => {
      const surfaces = makeSurfaces();
      const router = createNotificationRouter({
        surfaces,
        readSsotMirror: async () => null,
      });

      await router.deliver(makeReq({ alarmId: 'a-1' }));
      expect(getDeliveryEntries()).toHaveLength(1);

      await router.clearAllForTrip();

      expect(surfaces.clearAllCalls).toBe(1);
      expect(getDeliveryEntries()).toHaveLength(0);

      // dedup 해제 — 같은 alarmId가 다시 deliver.
      const after = await router.deliver(makeReq({ alarmId: 'a-1' }));
      expect(after.delivered).toBe(true);
      expect(surfaces.bannerCalls).toBe(2);
    });

    it('clearAllForTrip works when surfaces.clearAll is undefined', async () => {
      const router = createNotificationRouter({
        surfaces: {
          banner: () => undefined,
          liveActivity: () => undefined,
          widget: () => undefined,
          inApp: () => undefined,
        },
        readSsotMirror: async () => null,
      });
      await expect(router.clearAllForTrip()).resolves.toBeUndefined();
    });

    it('clearAllForTrip swallows clearAll errors', async () => {
      const router = createNotificationRouter({
        surfaces: {
          banner: () => undefined,
          liveActivity: () => undefined,
          widget: () => undefined,
          inApp: () => undefined,
          clearAll: () => {
            throw new Error('cleanup boom');
          },
        },
        readSsotMirror: async () => null,
      });
      await expect(router.clearAllForTrip()).resolves.toBeUndefined();
    });
  });

  describe('regression: 88건 spam scenario', () => {
    it('88 fire attempts of same (alarmId, surface) → 1 deliver + 87 suppress', async () => {
      const surfaces = makeSurfaces();
      const router = createNotificationRouter({
        surfaces,
        readSsotMirror: async () => null,
      });

      const results = [];
      for (let i = 0; i < 88; i += 1) {
        results.push(
          // eslint-disable-next-line no-await-in-loop
          await router.deliver(makeReq({ alarmId: 'spam' })),
        );
      }
      const delivered = results.filter((r) => r.delivered).length;
      const suppressed = results.filter(
        (r) => !r.delivered && r.reason === 'dedup-same-surface',
      ).length;
      expect(delivered).toBe(1);
      expect(suppressed).toBe(87);
      expect(surfaces.bannerCalls).toBe(1);
    });
  });
});
