import {
  fusionDestinationSignal,
  arcCompletionSignal,
  etaBackstopSignal,
  shouldTriggerSelfEnd,
  isStrongFusionConfidenceForSelfEnd,
  hasObservedDestinationPush,
  destinationPushGatePassed,
  DESTINATION_PUSH_TIMEOUT_MS,
} from '../deviceSelfEndSignals';
import type { FusionConfidence } from '../../../../shared/types/fusion';

const NOW = 1_000_000;
const STATION_ID = 'seongsu';
const DESTINATION_ID = 'seongsu';
const OTHER_ID = 'gundae';

describe('isStrongFusionConfidenceForSelfEnd', () => {
  it.each<[FusionConfidence, boolean]>([
    ['backend-ssot', true],
    ['boarding-lock', true],
    ['boarding-lock-interp', true],
    ['position-train', true],
    ['arrival-confirmed', true],
    ['arrival-arriving', true],
    ['route-progress', true],
    ['wifi-ssid', true],
    ['detection-fused', true],
    ['gps-only', false],
    ['gps-only-underground', false],
  ])('confidence=%s => %s', (c, expected) => {
    expect(isStrongFusionConfidenceForSelfEnd(c)).toBe(expected);
  });
});

describe('fusionDestinationSignal', () => {
  it('destinationId null이면 trigger false (no active trip)', () => {
    const v = fusionDestinationSignal(
      STATION_ID,
      null,
      'backend-ssot',
      NOW - 60_000,
      NOW,
    );
    expect(v).toEqual({ trigger: false, reason: null });
  });

  it('currentStation null이면 trigger false', () => {
    const v = fusionDestinationSignal(
      null,
      DESTINATION_ID,
      'backend-ssot',
      NOW - 60_000,
      NOW,
    );
    expect(v).toEqual({ trigger: false, reason: null });
  });

  it('mismatch (다른 station) → trigger false', () => {
    const v = fusionDestinationSignal(
      OTHER_ID,
      DESTINATION_ID,
      'backend-ssot',
      NOW - 60_000,
      NOW,
    );
    expect(v).toEqual({ trigger: false, reason: null });
  });

  it('confidence null → trigger false', () => {
    const v = fusionDestinationSignal(
      STATION_ID,
      DESTINATION_ID,
      null,
      NOW - 60_000,
      NOW,
    );
    expect(v).toEqual({ trigger: false, reason: null });
  });

  it('gps-only confidence → trigger false (약 신호 배제)', () => {
    const v = fusionDestinationSignal(
      STATION_ID,
      DESTINATION_ID,
      'gps-only',
      NOW - 60_000,
      NOW,
    );
    expect(v).toEqual({ trigger: false, reason: null });
  });

  it('gps-only-underground → trigger false', () => {
    const v = fusionDestinationSignal(
      STATION_ID,
      DESTINATION_ID,
      'gps-only-underground',
      NOW - 60_000,
      NOW,
    );
    expect(v).toEqual({ trigger: false, reason: null });
  });

  it('destinationMatchStartedAt null → trigger false (첫 tick, 아직 match 시작 전)', () => {
    const v = fusionDestinationSignal(
      STATION_ID,
      DESTINATION_ID,
      'backend-ssot',
      null,
      NOW,
    );
    expect(v).toEqual({ trigger: false, reason: null });
  });

  it('duration < 30s → trigger false', () => {
    const v = fusionDestinationSignal(
      STATION_ID,
      DESTINATION_ID,
      'backend-ssot',
      NOW - 29_999,
      NOW,
    );
    expect(v).toEqual({ trigger: false, reason: null });
  });

  it('duration = 30s → trigger true', () => {
    const v = fusionDestinationSignal(
      STATION_ID,
      DESTINATION_ID,
      'backend-ssot',
      NOW - 30_000,
      NOW,
    );
    expect(v).toEqual({ trigger: true, reason: 'fusion-destination' });
  });

  it('duration > 30s + arrival-arriving confidence → trigger true', () => {
    const v = fusionDestinationSignal(
      STATION_ID,
      DESTINATION_ID,
      'arrival-arriving',
      NOW - 60_000,
      NOW,
    );
    expect(v).toEqual({ trigger: true, reason: 'fusion-destination' });
  });

  it('requiredDurationMs override (10s)', () => {
    const v = fusionDestinationSignal(
      STATION_ID,
      DESTINATION_ID,
      'backend-ssot',
      NOW - 10_000,
      NOW,
      10_000,
    );
    expect(v.trigger).toBe(true);
  });
});

describe('arcCompletionSignal', () => {
  it('arc null → trigger false', () => {
    const v = arcCompletionSignal(null, true, NOW - 60_000, NOW);
    expect(v).toEqual({ trigger: false, reason: null });
  });

  it('arc < 0.95 → trigger false', () => {
    const v = arcCompletionSignal(0.94, true, NOW - 60_000, NOW);
    expect(v).toEqual({ trigger: false, reason: null });
  });

  it('arc >= 0.95 + moving (stationary false) → trigger false', () => {
    const v = arcCompletionSignal(0.95, false, NOW - 60_000, NOW);
    expect(v).toEqual({ trigger: false, reason: null });
  });

  it('arc >= 0.95 + stationary but stationaryStartedAt null → trigger false', () => {
    const v = arcCompletionSignal(0.95, true, null, NOW);
    expect(v).toEqual({ trigger: false, reason: null });
  });

  it('arc >= 0.95 + stationary < 60s → trigger false', () => {
    const v = arcCompletionSignal(0.95, true, NOW - 59_999, NOW);
    expect(v).toEqual({ trigger: false, reason: null });
  });

  it('arc >= 0.95 + stationary 60s → trigger true', () => {
    const v = arcCompletionSignal(0.95, true, NOW - 60_000, NOW);
    expect(v).toEqual({ trigger: true, reason: 'arc-completion' });
  });

  it('arc = 1.0 + stationary > 60s → trigger true', () => {
    const v = arcCompletionSignal(1.0, true, NOW - 90_000, NOW);
    expect(v).toEqual({ trigger: true, reason: 'arc-completion' });
  });

  it('progressThreshold override (0.9)', () => {
    const v = arcCompletionSignal(0.91, true, NOW - 60_000, NOW, 60_000, 0.9);
    expect(v.trigger).toBe(true);
  });
});

describe('etaBackstopSignal', () => {
  const ETA_MS = 30 * 60_000; // 30분 예상 trip

  it('tripStartedAt null → trigger false', () => {
    const v = etaBackstopSignal(null, ETA_MS, NOW - 5 * 60_000, NOW);
    expect(v).toEqual({ trigger: false, reason: null });
  });

  it('expectedEtaMs null → trigger false', () => {
    const v = etaBackstopSignal(NOW - ETA_MS * 3, null, NOW - 5 * 60_000, NOW);
    expect(v).toEqual({ trigger: false, reason: null });
  });

  it('expectedEtaMs <= 0 → trigger false (invalid input)', () => {
    const v = etaBackstopSignal(NOW - ETA_MS * 3, 0, NOW - 5 * 60_000, NOW);
    expect(v).toEqual({ trigger: false, reason: null });
  });

  it('elapsed <= eta × 2 → trigger false', () => {
    const v = etaBackstopSignal(NOW - ETA_MS * 2, ETA_MS, NOW - 5 * 60_000, NOW);
    expect(v).toEqual({ trigger: false, reason: null });
  });

  it('elapsed > eta × 2 + stationary5minStartedAt null → trigger false', () => {
    const v = etaBackstopSignal(NOW - ETA_MS * 3, ETA_MS, null, NOW);
    expect(v).toEqual({ trigger: false, reason: null });
  });

  it('elapsed > eta × 2 + stationary < 5min → trigger false', () => {
    const v = etaBackstopSignal(
      NOW - ETA_MS * 3,
      ETA_MS,
      NOW - 5 * 60_000 + 1,
      NOW,
    );
    expect(v).toEqual({ trigger: false, reason: null });
  });

  it('elapsed > eta × 2 + stationary 5min → trigger true', () => {
    const v = etaBackstopSignal(
      NOW - ETA_MS * 3,
      ETA_MS,
      NOW - 5 * 60_000,
      NOW,
    );
    expect(v).toEqual({ trigger: true, reason: 'eta-backstop' });
  });

  it('KTX 시나리오: expectedEta 3h → elapsed 6h (== eta × 2) → trigger false (자연 방어)', () => {
    const ktxEta = 3 * 60 * 60_000;
    const v = etaBackstopSignal(
      NOW - ktxEta * 2,
      ktxEta,
      NOW - 5 * 60_000,
      NOW,
    );
    expect(v.trigger).toBe(false);
  });

  it('KTX 시나리오: expectedEta 3h → elapsed 6h + 1s → trigger true', () => {
    const ktxEta = 3 * 60 * 60_000;
    const v = etaBackstopSignal(
      NOW - ktxEta * 2 - 1_000,
      ktxEta,
      NOW - 5 * 60_000,
      NOW,
    );
    expect(v.trigger).toBe(true);
  });

  it('stationaryDurationMs override (1min)', () => {
    const v = etaBackstopSignal(
      NOW - ETA_MS * 3,
      ETA_MS,
      NOW - 60_000,
      NOW,
      60_000,
    );
    expect(v.trigger).toBe(true);
  });
});

describe('shouldTriggerSelfEnd', () => {
  it('empty → trigger false', () => {
    const v = shouldTriggerSelfEnd([]);
    expect(v).toEqual({ trigger: false, reason: null });
  });

  it('모두 false → trigger false', () => {
    const v = shouldTriggerSelfEnd([
      { trigger: false, reason: null },
      { trigger: false, reason: null },
      { trigger: false, reason: null },
    ]);
    expect(v).toEqual({ trigger: false, reason: null });
  });

  it('Signal 1만 trigger → fusion-destination', () => {
    const v = shouldTriggerSelfEnd([
      { trigger: true, reason: 'fusion-destination' },
      { trigger: false, reason: null },
      { trigger: false, reason: null },
    ]);
    expect(v).toEqual({ trigger: true, reason: 'fusion-destination' });
  });

  it('Signal 2만 trigger → arc-completion', () => {
    const v = shouldTriggerSelfEnd([
      { trigger: false, reason: null },
      { trigger: true, reason: 'arc-completion' },
      { trigger: false, reason: null },
    ]);
    expect(v).toEqual({ trigger: true, reason: 'arc-completion' });
  });

  it('Signal 3만 trigger → eta-backstop', () => {
    const v = shouldTriggerSelfEnd([
      { trigger: false, reason: null },
      { trigger: false, reason: null },
      { trigger: true, reason: 'eta-backstop' },
    ]);
    expect(v).toEqual({ trigger: true, reason: 'eta-backstop' });
  });

  it('여러 signal trigger → 첫 signal 우선 (배열 순서 = 우선순위)', () => {
    const v = shouldTriggerSelfEnd([
      { trigger: true, reason: 'fusion-destination' },
      { trigger: true, reason: 'arc-completion' },
      { trigger: true, reason: 'eta-backstop' },
    ]);
    expect(v).toEqual({ trigger: true, reason: 'fusion-destination' });
  });
});

describe('#2341 hasObservedDestinationPush', () => {
  it('빈 배열 → false', () => {
    expect(hasObservedDestinationPush([], NOW)).toBe(false);
  });

  it('destination kind + silent-push-received + sinceTs 이후 → true', () => {
    expect(
      hasObservedDestinationPush(
        [{ ts: NOW + 1, source: 'silent-push-received', kind: 'destination' }],
        NOW,
      ),
    ).toBe(true);
  });

  it('ts === sinceTs (경계값) → true', () => {
    expect(
      hasObservedDestinationPush(
        [{ ts: NOW, source: 'silent-push-received', kind: 'destination' }],
        NOW,
      ),
    ).toBe(true);
  });

  it('ts가 sinceTs 이전 → false (destination-match 시작 이전 push는 이 trip 것 아님)', () => {
    expect(
      hasObservedDestinationPush(
        [{ ts: NOW - 1, source: 'silent-push-received', kind: 'destination' }],
        NOW,
      ),
    ).toBe(false);
  });

  it('kind가 station-passed/transfer면 destination 아니라 false', () => {
    expect(
      hasObservedDestinationPush(
        [
          { ts: NOW + 1, source: 'silent-push-received', kind: 'station-passed' },
          { ts: NOW + 1, source: 'silent-push-received', kind: 'transfer' },
        ],
        NOW,
      ),
    ).toBe(false);
  });

  it('source가 silent-push-received 아니면 false (kind만 destination이어도)', () => {
    expect(
      hasObservedDestinationPush(
        [{ ts: NOW + 1, source: 'lifecycle-backstop', kind: 'destination' }],
        NOW,
      ),
    ).toBe(false);
  });
});

describe('#2341 destinationPushGatePassed', () => {
  it('push 관측됨 → matchStartedAt/timeout 무관 즉시 true', () => {
    expect(destinationPushGatePassed(null, NOW, true)).toBe(true);
    expect(destinationPushGatePassed(NOW, NOW, true)).toBe(true);
  });

  it('push 미관측 + matchStartedAt null → false', () => {
    expect(destinationPushGatePassed(null, NOW, false)).toBe(false);
  });

  it('push 미관측 + 타임아웃 미도달 → false (race 차단)', () => {
    expect(
      destinationPushGatePassed(NOW, NOW + DESTINATION_PUSH_TIMEOUT_MS - 1, false),
    ).toBe(false);
  });

  it('push 미관측 + 타임아웃 도달 → true (stale-trip 방지 백스톱)', () => {
    expect(
      destinationPushGatePassed(NOW, NOW + DESTINATION_PUSH_TIMEOUT_MS, false),
    ).toBe(true);
  });

  it('timeoutMs override', () => {
    expect(destinationPushGatePassed(NOW, NOW + 1_000, false, 1_000)).toBe(true);
    expect(destinationPushGatePassed(NOW, NOW + 999, false, 1_000)).toBe(false);
  });
});
