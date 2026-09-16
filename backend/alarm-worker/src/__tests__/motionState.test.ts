import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MOTION_MIN_SAMPLES,
  MOTION_WINDOW_MS,
  SSOT_MOTION_WRITE_MIN_INTERVAL_MS,
  computeMotionState,
  emitMotionTransitionBreadcrumb,
  hasArvlcdTrainProgress,
  maxDisplacementMeters,
  updateSsotMotion,
} from '../motionState';
import {
  DEVICE_SYNC_STALE_THRESHOLD_MS,
  seedSsot,
  readSsot,
  writeSsot,
  type MotionEvidence,
  type TripPositionSSoT,
} from '../tripPositionSsot';
import type { PositionPoint } from '../types';
import { InMemoryKV } from './inMemoryKv';

/**
 * Sub #1556 / T3 — Motion state machine acceptance.
 *
 * - it.each 6 양방향 시나리오 (issue 본문 보강 섹션 그대로)
 * - maxDisplacementMeters: pair-wise haversine max
 * - hasArvlcdTrainProgress: source/stationId 분포 카운트
 * - updateSsotMotion: SSOT 없으면 no-op, evidence push, breadcrumb emit, write back
 * - emitMotionTransitionBreadcrumb: from===to no-op + PII-free 출력
 */

function makeSsot(overrides?: Partial<TripPositionSSoT>): TripPositionSSoT {
  return {
    tripToken: 'tok-test',
    currentStationId: '0228',
    motionState: 'unknown',
    motionEvidence: [],
    lastAdvanceAt: 0,
    lastAdvanceEvidence: 'seed-override',
    passedStations: [],
    userIntentDeclared: false,
    seedOverrideCount: 0,
    schemaVersion: 1,
    ...overrides,
  };
}

function makePosition(overrides?: Partial<PositionPoint>): PositionPoint {
  return {
    lat: 37.5,
    lng: 127.0,
    accuracy: 10,
    ts: 1_000_000,
    motion: 'unknown',
    ...overrides,
  };
}

/**
 * 위도 37.5에서 1m ≈ 9e-6 도 (대략) — 본 단위는 displacement 시나리오 작성용.
 *
 * 정확도가 필요한 곳은 직접 haversineKm로 검증. 본 helper는 evidence 합성 편의용.
 */
function gpsEvidence(
  lat: number,
  lng: number,
  ts: number,
  motion: PositionPoint['motion'] = 'unknown',
): MotionEvidence {
  return {
    source: 'device-position',
    ts,
    signal: { lat, lng, motion },
  };
}

function arvlcdEvidence(stationId: string, ts: number): MotionEvidence {
  return {
    source: 'seoul-arvlcd',
    ts,
    signal: { stationId },
  };
}

describe('maxDisplacementMeters', () => {
  it('0~1 sample → 0 반환 (변위 측정 불가)', () => {
    expect(maxDisplacementMeters([])).toBe(0);
    expect(maxDisplacementMeters([gpsEvidence(37.5, 127.0, 1)])).toBe(0);
  });

  it('non device-position source는 제외', () => {
    const evidence = [
      arvlcdEvidence('0228', 1),
      arvlcdEvidence('0229', 2),
    ];
    expect(maxDisplacementMeters(evidence)).toBe(0);
  });

  it('signal payload가 lat/lng 결여 시 graceful skip', () => {
    const bad: MotionEvidence[] = [
      { source: 'device-position', ts: 1, signal: null },
      { source: 'device-position', ts: 2, signal: 'string-not-obj' },
      { source: 'device-position', ts: 3, signal: { lat: 37.5 } },
      { source: 'device-position', ts: 4, signal: { lat: 'x', lng: 127.0 } },
      { source: 'device-position', ts: 5, signal: { lat: NaN, lng: 127.0 } },
    ];
    expect(maxDisplacementMeters(bad)).toBe(0);
  });

  it('2건 이상 좌표 → pair-wise max displacement (m)', () => {
    // 위도 37.5, 경도 0.0001 차이 ≈ 8.8m
    const evidence = [
      gpsEvidence(37.5, 127.0, 1),
      gpsEvidence(37.5, 127.0001, 2),
      gpsEvidence(37.5, 127.0, 3),
    ];
    const d = maxDisplacementMeters(evidence);
    expect(d).toBeGreaterThan(5);
    expect(d).toBeLessThan(15);
  });

  it('윈도우 내 가장 먼 한 쌍을 선택 (pair-wise max)', () => {
    const evidence = [
      gpsEvidence(37.5, 127.0, 1),
      gpsEvidence(37.5, 127.0001, 2), // ~8.8m from base
      gpsEvidence(37.5, 127.001, 3), // ~88m from base
    ];
    const d = maxDisplacementMeters(evidence);
    expect(d).toBeGreaterThan(80);
    expect(d).toBeLessThan(100);
  });
});

describe('hasArvlcdTrainProgress', () => {
  it('arvlcd evidence 없으면 false', () => {
    const ssot = makeSsot();
    expect(hasArvlcdTrainProgress(ssot, 0)).toBe(false);
  });

  it('같은 stationId 여러 건은 progress 아님', () => {
    const ssot = makeSsot({
      motionEvidence: [
        arvlcdEvidence('0228', 10),
        arvlcdEvidence('0228', 20),
        arvlcdEvidence('0228', 30),
      ],
    });
    expect(hasArvlcdTrainProgress(ssot, 0)).toBe(false);
  });

  it('다른 stationId 2건 이상 → progress (true)', () => {
    const ssot = makeSsot({
      motionEvidence: [
        arvlcdEvidence('0228', 10),
        arvlcdEvidence('0229', 20),
      ],
    });
    expect(hasArvlcdTrainProgress(ssot, 0)).toBe(true);
  });

  it('sinceMs 이전 evidence는 무시', () => {
    const ssot = makeSsot({
      motionEvidence: [
        arvlcdEvidence('0228', 10),
        arvlcdEvidence('0229', 20),
      ],
    });
    expect(hasArvlcdTrainProgress(ssot, 100)).toBe(false);
  });

  it('non-arvlcd source는 무시', () => {
    const ssot = makeSsot({
      motionEvidence: [
        gpsEvidence(37.5, 127.0, 10),
        gpsEvidence(37.6, 128.0, 20),
      ],
    });
    expect(hasArvlcdTrainProgress(ssot, 0)).toBe(false);
  });

  it('signal payload 결함 sample은 graceful skip', () => {
    const ssot = makeSsot({
      motionEvidence: [
        { source: 'seoul-arvlcd', ts: 10, signal: null },
        { source: 'seoul-arvlcd', ts: 11, signal: 'str' },
        { source: 'seoul-arvlcd', ts: 12, signal: {} },
        { source: 'seoul-arvlcd', ts: 13, signal: { stationId: 123 } },
        { source: 'seoul-arvlcd', ts: 14, signal: { stationId: '' } },
        arvlcdEvidence('0228', 15),
      ],
    });
    // 유효 stationId 1개 → false
    expect(hasArvlcdTrainProgress(ssot, 0)).toBe(false);
  });
});

describe('computeMotionState — 보강 섹션 6 양방향 시나리오 (it.each)', () => {
  const now = 1_000_000;
  const baseSamples = (count: number, displacementM: number): MotionEvidence[] => {
    // count 개 sample 생성 — 첫번째와 마지막이 약 displacementM 떨어진 좌표.
    // 위도 변화로 displacement 부여 — 위도 1° ≈ 111,320m. 1m ≈ 8.98e-6 deg.
    // 안전 마진 위해 displacement 1.5배 부여 (haversine pair-wise max는 약간 더 큰 값 산출).
    const degPerM = 1 / 111_320;
    const result: MotionEvidence[] = [];
    for (let i = 0; i < count; i++) {
      const latOffset = (i === count - 1 ? displacementM : 0) * degPerM;
      result.push(gpsEvidence(37.5 + latOffset, 127.0, now - MOTION_WINDOW_MS + i * 1000));
    }
    return result;
  };

  const scenarios = [
    {
      name: 'device walking → moving (즉시)',
      deviceMotion: 'walking' as const,
      samples: 0,
      displacement: 0,
      arvlcdProgress: false,
      expected: 'moving' as const,
    },
    {
      name: 'device stationary → stationary (즉시)',
      deviceMotion: 'stationary' as const,
      samples: 0,
      displacement: 0,
      arvlcdProgress: false,
      expected: 'stationary' as const,
    },
    {
      name: 'unknown + 10 samples + displ <10m + no progress → stationary',
      deviceMotion: 'unknown' as const,
      samples: 10,
      displacement: 5,
      arvlcdProgress: false,
      expected: 'stationary' as const,
    },
    {
      name: 'unknown + 10 samples + displ <10m + arvlcd progress → unknown (보수)',
      deviceMotion: 'unknown' as const,
      samples: 10,
      displacement: 5,
      arvlcdProgress: true,
      expected: 'unknown' as const,
    },
    {
      name: 'unknown + displ >50m → moving',
      deviceMotion: 'unknown' as const,
      samples: 10,
      displacement: 60,
      arvlcdProgress: false,
      expected: 'moving' as const,
    },
    {
      name: 'unknown + 9 samples (부족) → unknown',
      deviceMotion: 'unknown' as const,
      samples: 9,
      displacement: 5,
      arvlcdProgress: false,
      expected: 'unknown' as const,
    },
  ];

  it.each(scenarios)('$name', ({ deviceMotion, samples, displacement, arvlcdProgress, expected }) => {
    const evidence = baseSamples(samples, displacement);
    if (arvlcdProgress) {
      evidence.push(arvlcdEvidence('0228', now - MOTION_WINDOW_MS + 1000));
      evidence.push(arvlcdEvidence('0229', now - MOTION_WINDOW_MS + 2000));
    }
    const ssot = makeSsot({ motionEvidence: evidence });
    const pos = makePosition({ motion: deviceMotion, ts: now });
    expect(computeMotionState(ssot, pos, now)).toBe(expected);
  });

  it('unknown + samples >= MIN + displacement 중간(10~50m) → unknown 보수 폴백', () => {
    const evidence = baseSamples(MOTION_MIN_SAMPLES, 25);
    const ssot = makeSsot({ motionEvidence: evidence });
    const pos = makePosition({ motion: 'unknown', ts: now });
    expect(computeMotionState(ssot, pos, now)).toBe('unknown');
  });

  it('automotive device motion → moving', () => {
    const ssot = makeSsot();
    const pos = makePosition({ motion: 'automotive', ts: now });
    expect(computeMotionState(ssot, pos, now)).toBe('moving');
  });

  it('윈도우 밖 sample은 판정 입력에서 제외 (5분 경계)', () => {
    // 11개 sample 중 1개만 윈도우 밖 — 윈도우 안은 10개 충족
    const oldSample = gpsEvidence(37.5, 127.0, now - MOTION_WINDOW_MS - 1000);
    const inWindow: MotionEvidence[] = [];
    for (let i = 0; i < MOTION_MIN_SAMPLES; i++) {
      inWindow.push(gpsEvidence(37.5, 127.0, now - MOTION_WINDOW_MS + 1000 + i * 100));
    }
    const ssot = makeSsot({ motionEvidence: [oldSample, ...inWindow] });
    const pos = makePosition({ motion: 'unknown', ts: now });
    // 윈도우 내 10건 displacement=0 → stationary
    expect(computeMotionState(ssot, pos, now)).toBe('stationary');
  });
});

describe('emitMotionTransitionBreadcrumb', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  it('from === to → no-op (transition 없음)', () => {
    emitMotionTransitionBreadcrumb('moving', 'moving');
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('전환 시 라벨만 emit (PII 금지)', () => {
    emitMotionTransitionBreadcrumb('unknown', 'stationary');
    expect(logSpy).toHaveBeenCalledTimes(1);
    const [tag, payload] = logSpy.mock.calls[0];
    expect(tag).toBe('[motion-transition]');
    expect(payload).toBe(JSON.stringify({ from: 'unknown', to: 'stationary' }));
    // PII 가드 — 좌표/displacement 키 절대 포함 X
    expect(payload as string).not.toContain('lat');
    expect(payload as string).not.toContain('lng');
    expect(payload as string).not.toContain('displacement');
  });
});

describe('updateSsotMotion — POST /position 수신 path', () => {
  let kv: InMemoryKV;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    kv = new InMemoryKV();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('SSOT 부재 시 null 반환 (no-op — trip 미등록 device)', async () => {
    const pos = makePosition();
    const result = await updateSsotMotion(
      kv as unknown as KVNamespace,
      'unknown-token',
      pos,
      1_000_000,
    );
    expect(result).toBeNull();
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('device walking → SSOT.motionState=moving + evidence push + breadcrumb', async () => {
    await seedSsot(kv as unknown as KVNamespace, 'tok-1', '0228');
    const pos = makePosition({ motion: 'walking', ts: 1_000_000 });
    const result = await updateSsotMotion(
      kv as unknown as KVNamespace,
      'tok-1',
      pos,
      1_000_000,
    );
    expect(result?.motionState).toBe('moving');
    expect(result?.motionEvidence).toHaveLength(1);
    expect(result?.motionEvidence[0].source).toBe('device-position');
    expect(logSpy).toHaveBeenCalledWith(
      '[motion-transition]',
      JSON.stringify({ from: 'unknown', to: 'moving' }),
    );
    // KV에 write 됐는지 확인
    const persisted = await readSsot(kv as unknown as KVNamespace, 'tok-1');
    expect(persisted?.motionState).toBe('moving');
    expect(persisted?.motionEvidence).toHaveLength(1);
  });

  it('state 유지(전환 없음) → breadcrumb emit 없음', async () => {
    const ssot = makeSsot({ tripToken: 'tok-2', motionState: 'moving' });
    await writeSsot(kv as unknown as KVNamespace, ssot);
    const pos = makePosition({ motion: 'walking', ts: 1_000_000 });
    const result = await updateSsotMotion(
      kv as unknown as KVNamespace,
      'tok-2',
      pos,
      1_000_000,
    );
    expect(result?.motionState).toBe('moving');
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('device unknown + GPS samples 누적 후 stationary 전환', async () => {
    // 이미 9 sample 누적된 SSOT (윈도우 내). 10번째 sample push 후 평가.
    const now = 1_000_000;
    const existing: MotionEvidence[] = [];
    for (let i = 0; i < 9; i++) {
      existing.push(gpsEvidence(37.5, 127.0, now - MOTION_WINDOW_MS + i * 1000));
    }
    const ssot = makeSsot({
      tripToken: 'tok-3',
      motionState: 'moving',
      motionEvidence: existing,
    });
    await writeSsot(kv as unknown as KVNamespace, ssot);
    const pos = makePosition({ lat: 37.5, lng: 127.0, motion: 'unknown', ts: now });
    const result = await updateSsotMotion(
      kv as unknown as KVNamespace,
      'tok-3',
      pos,
      now,
    );
    expect(result?.motionEvidence).toHaveLength(10);
    expect(result?.motionState).toBe('stationary');
    expect(logSpy).toHaveBeenCalledWith(
      '[motion-transition]',
      JSON.stringify({ from: 'moving', to: 'stationary' }),
    );
  });
});

describe('updateSsotMotion — write throttle (KV quota #2439-ish)', () => {
  let kv: InMemoryKV;

  beforeEach(() => {
    kv = new InMemoryKV();
  });

  it('motionEvidence가 out-of-order(최신 evidence가 배열 뒤쪽 아님)여도 최신 ts 기준으로 스로틀 판단', async () => {
    // #newestDevicePositionEvidenceTs 분기 커버 — 두 번째 device-position entry의 ts가
    // 첫 번째보다 작은(과거) 경우에도 max(ts)를 정확히 찾아야 함 + non-device-position 소스는
    // 스킵되어야 함.
    const ssot = makeSsot({
      tripToken: 'tok-order',
      motionEvidence: [
        gpsEvidence(37.5, 127.0, 100_000),
        gpsEvidence(37.5, 127.0, 50_000),
        arvlcdEvidence('0228', 90_000),
      ],
    });
    await writeSsot(kv as unknown as KVNamespace, ssot);
    // now - newest(100_000) = 30_000 ≥ SSOT_MOTION_WRITE_MIN_INTERVAL_MS(25_000) → write 진행
    const now = 130_000;
    const result = await updateSsotMotion(
      kv as unknown as KVNamespace,
      'tok-order',
      makePosition({ ts: now }),
      now,
    );
    expect(result?.motionEvidence).toHaveLength(4);
  });

  it('cold start(evidence 없음)는 항상 write', async () => {
    await seedSsot(kv as unknown as KVNamespace, 'tok-cold', '0228');
    const pos = makePosition({ ts: 1_000_000 });
    const result = await updateSsotMotion(
      kv as unknown as KVNamespace,
      'tok-cold',
      pos,
      1_000_000,
    );
    expect(result?.motionEvidence).toHaveLength(1);
    const persisted = await readSsot(kv as unknown as KVNamespace, 'tok-cold');
    expect(persisted?.motionEvidence).toHaveLength(1);
  });

  it('직전 evidence로부터 간격 미달 → evidence push/write 둘 다 skip', async () => {
    await seedSsot(kv as unknown as KVNamespace, 'tok-skip', '0228');
    await updateSsotMotion(
      kv as unknown as KVNamespace,
      'tok-skip',
      makePosition({ ts: 0 }),
      0,
    );
    const result = await updateSsotMotion(
      kv as unknown as KVNamespace,
      'tok-skip',
      makePosition({ ts: SSOT_MOTION_WRITE_MIN_INTERVAL_MS - 1 }),
      SSOT_MOTION_WRITE_MIN_INTERVAL_MS - 1,
    );
    // skip이므로 evidence는 여전히 1건, lastDeviceSyncAt도 첫 write 시점(0)에 머무름.
    expect(result?.motionEvidence).toHaveLength(1);
    expect(result?.lastDeviceSyncAt).toBe(0);
    const persisted = await readSsot(kv as unknown as KVNamespace, 'tok-skip');
    expect(persisted?.motionEvidence).toHaveLength(1);
  });

  it('간격 충족(정확히 interval) → write 진행 (evidence 2건)', async () => {
    await seedSsot(kv as unknown as KVNamespace, 'tok-write', '0228');
    await updateSsotMotion(
      kv as unknown as KVNamespace,
      'tok-write',
      makePosition({ ts: 0 }),
      0,
    );
    const result = await updateSsotMotion(
      kv as unknown as KVNamespace,
      'tok-write',
      makePosition({ ts: SSOT_MOTION_WRITE_MIN_INTERVAL_MS }),
      SSOT_MOTION_WRITE_MIN_INTERVAL_MS,
    );
    expect(result?.motionEvidence).toHaveLength(2);
    expect(result?.lastDeviceSyncAt).toBe(SSOT_MOTION_WRITE_MIN_INTERVAL_MS);
  });

  it(
    'lastDeviceSyncAt은 25s 스로틀 cadence에서도 DEVICE_SYNC_STALE_THRESHOLD_MS(5min) ' +
      '안에서 항상 신선 (자명 — write 자체가 최소 25s마다 일어남)',
    () => {
      expect(SSOT_MOTION_WRITE_MIN_INTERVAL_MS).toBeLessThan(
        DEVICE_SYNC_STALE_THRESHOLD_MS,
      );
    },
  );

  it(
    '#1 우선순위 — 25s 스로틀 cadence로 5분 시뮬레이션(디바이스는 10s마다 호출, ' +
      "motion='unknown' + 무변위 GPS) → evidence 버퍼가 MOTION_MIN_SAMPLES 이상 쌓여 " +
      "computeMotionState가 'stationary'로 수렴 (버퍼 starvation이면 'unknown' 고착 → " +
      '#2433 motion-gate blindspot류 회귀 재현 방지)',
    async () => {
      await seedSsot(kv as unknown as KVNamespace, 'tok-density', '0228');
      const startNow = 1_000_000;
      const totalMs = MOTION_WINDOW_MS; // 5분
      const deviceCallIntervalMs = 10_000; // 실제 디바이스 POST /position 주기
      let result: TripPositionSSoT | null = null;
      for (let elapsed = 0; elapsed <= totalMs; elapsed += deviceCallIntervalMs) {
        const now = startNow + elapsed;
        const pos = makePosition({ motion: 'unknown', ts: now });
        result = await updateSsotMotion(kv as unknown as KVNamespace, 'tok-density', pos, now);
      }
      expect(result).not.toBeNull();
      const deviceEvidence = result!.motionEvidence.filter(
        (e) => e.source === 'device-position',
      );
      expect(deviceEvidence.length).toBeGreaterThanOrEqual(MOTION_MIN_SAMPLES);
      expect(result!.motionState).toBe('stationary');
    },
  );
});
