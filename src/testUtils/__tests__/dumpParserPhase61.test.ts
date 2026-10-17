/**
 * #1875 — dumpParser Phase 6.1 확장 필드 파싱 테스트.
 *
 * 검증 범위:
 * 1. gpsAccuracy 파싱 (## GPS accuracy=N m)
 * 2. environment 파싱 (subsurface / fusionConfidence / Environment Distribution / fallback)
 * 3. coldStart 섹션 파싱 (yes/no 필드 + 숫자 필드)
 * 4. 섹션 부재 graceful (undefined / default values)
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDumpFixture } from '../dumpParser';

const PHASE61_DIR = join(__dirname, '../fixtures/phase61');
const DAY2_DIR = join(__dirname, '../fixtures/day2');

function loadFixture(dir: string, filename: string) {
  return readFileSync(join(dir, filename), 'utf-8');
}

// ─── gpsAccuracy 파싱 ─────────────────────────────────────────────────────────

describe('parseDumpFixture — gpsAccuracy 파싱', () => {
  it('morning-trip: accuracy=28.4m 파싱', () => {
    const f = parseDumpFixture(loadFixture(DAY2_DIR, 'morning-trip.txt'));
    expect(f.gpsAccuracy).toBeCloseTo(28.425, 1);
  });

  it('cold-start-full-chain: accuracy=350.0 파싱', () => {
    const f = parseDumpFixture(loadFixture(PHASE61_DIR, 'cold-start-full-chain.txt'));
    expect(f.gpsAccuracy).toBe(350.0);
  });

  it('cold-start-fallback-derived: accuracy=600.0 파싱', () => {
    const f = parseDumpFixture(loadFixture(PHASE61_DIR, 'cold-start-fallback-derived.txt'));
    expect(f.gpsAccuracy).toBe(600.0);
  });

  it('## GPS 섹션 없으면 gpsAccuracy=undefined', () => {
    const f = parseDumpFixture('## Trip\nlifecyclePhase=none\n');
    expect(f.gpsAccuracy).toBeUndefined();
  });

  it('## GPS 섹션 있지만 accuracy 행 없으면 undefined', () => {
    const f = parseDumpFixture('## GPS\nlat=37.50, lng=127.00, speed=1.0 m/s\n');
    expect(f.gpsAccuracy).toBeUndefined();
  });
});

// ─── environment 파싱 ────────────────────────────────────────────────────────

describe('parseDumpFixture — environment 파싱', () => {
  it('subsurface=true → underground', () => {
    const f = parseDumpFixture(loadFixture(PHASE61_DIR, 'cold-start-full-chain.txt'));
    expect(f.environment).toBe('underground');
  });

  it('subsurface=false (지상) → surface', () => {
    const f = parseDumpFixture(loadFixture(DAY2_DIR, 'morning-trip.txt'));
    expect(f.environment).toBe('surface');
  });

  it('subsurface=false이지만 fusionConfidence에 underground 포함 → underground 우선', () => {
    // subsurface=false이더라도 confidence=gps-only-underground면 underground
    const text = `## GPS
lat=37.50, lng=127.00, speed=- m/s, accuracy=200.0 m
subsurface=false (readings=2)

## Fusion
confidence=gps-only-underground, source=gps
`;
    const f = parseDumpFixture(text);
    // subsurface=false가 먼저 체크되므로 surface로 나와야 함 (parse 순서대로)
    // 실제: parseEnvironment는 subsurface=true 먼저 체크 → false면 다음 단계로.
    // subsurface=false이면 Fusion confidence 체크 → underground 포함 → underground
    expect(f.environment).toBe('underground');
  });

  it('subsurface=false + confidence=gps-only → surface', () => {
    const f = parseDumpFixture(loadFixture(DAY2_DIR, 'regression-lockless-no-intent.txt'));
    expect(f.environment).toBe('surface');
  });

  it('## GPS 섹션 없으면 environment=undefined', () => {
    const f = parseDumpFixture('## Fusion\nconfidence=gps-only\n');
    // GPS 섹션 없음 → subsurface 체크 불가
    // Fusion confidence=gps-only → underground 없음
    // GPS/Fusion subsurface 없음 → environment=undefined (surface fallback 불가)
    expect(f.environment).toBeUndefined();
  });

  it('Environment Distribution 섹션: unknown=100% → unknown', () => {
    const text = `## GPS
lat=37.50, lng=127.00, speed=- m/s, accuracy=500.0 m
subsurface=false (readings=0)

## Fusion
confidence=gps-only, source=gps

## Environment Distribution
unknown=100.0%
surface=0.0%
underground=0.0%
`;
    const f = parseDumpFixture(text);
    // subsurface=false → surface 체크 후 Environment Distribution 확인
    // 그런데 parseEnvironment는 subsurface=false이면 surface 반환
    // (surface fallback은 마지막). Environment Distribution은 subsurface=true/confidence 체크 후 확인.
    // subsurface=false AND confidence=gps-only(no underground) → 다음 단계: Environment Distribution
    // unknown=100.0% >= 80% → 'unknown'
    expect(f.environment).toBe('unknown');
  });

  it('Environment Distribution: underground=75% → underground', () => {
    const text = `## GPS
lat=37.50, lng=127.00, speed=- m/s, accuracy=200.0 m
subsurface=false (readings=5)

## Fusion
confidence=gps-only, source=gps

## Environment Distribution
underground=75.0%
surface=25.0%
`;
    const f = parseDumpFixture(text);
    expect(f.environment).toBe('underground');
  });

  it('Environment Distribution: underground=30% (< 50%) → surface (subsurface=false fallback)', () => {
    // underM 매칭됐지만 parseFloat < 50 → branch false → surface fallback (line 234 false branch)
    const text = `## GPS
lat=37.50, lng=127.00, speed=- m/s, accuracy=200.0 m
subsurface=false (readings=10)

## Fusion
confidence=gps-only, source=gps

## Environment Distribution
underground=30.0%
surface=70.0%
`;
    const f = parseDumpFixture(text);
    expect(f.environment).toBe('surface');
  });
});

// ─── coldStart 섹션 파싱 ─────────────────────────────────────────────────────

describe('parseDumpFixture — coldStart 섹션 파싱', () => {
  it('full-chain: 모든 필드 파싱 정확', () => {
    const f = parseDumpFixture(loadFixture(PHASE61_DIR, 'cold-start-full-chain.txt'));
    expect(f.coldStart).toEqual({
      detected: true,
      candidatesCount: 3,
      weightedCount: 3,
      pickerShown: true,
      userSelected: true,
    });
  });

  it('detected-only: detected=yes, 나머지 0/no', () => {
    const f = parseDumpFixture(loadFixture(PHASE61_DIR, 'cold-start-detected-only.txt'));
    expect(f.coldStart).toEqual({
      detected: true,
      candidatesCount: 0,
      weightedCount: 0,
      pickerShown: false,
      userSelected: false,
    });
  });

  it('mismatch: userSelected=yes + pickerShown=yes', () => {
    const f = parseDumpFixture(loadFixture(PHASE61_DIR, 'cold-start-mismatch.txt'));
    expect(f.coldStart?.userSelected).toBe(true);
    expect(f.coldStart?.pickerShown).toBe(true);
  });

  it('## Cold Start 섹션 없으면 coldStart=undefined', () => {
    const f = parseDumpFixture(loadFixture(DAY2_DIR, 'morning-trip.txt'));
    expect(f.coldStart).toBeUndefined();
  });

  it('fallback-derived: 섹션 없음 → coldStart=undefined', () => {
    const f = parseDumpFixture(loadFixture(PHASE61_DIR, 'cold-start-fallback-derived.txt'));
    expect(f.coldStart).toBeUndefined();
  });

  it('## Cold Start 섹션 부분 필드만 있으면 나머지는 기본값', () => {
    const text = `## Cold Start
detected=yes
candidatesCount=2
`;
    const f = parseDumpFixture(text);
    expect(f.coldStart).toEqual({
      detected: true,
      candidatesCount: 2,
      weightedCount: 0,   // 기본값
      pickerShown: false, // 기본값
      userSelected: false, // 기본값
    });
  });

  it('빈 텍스트 → coldStart=undefined', () => {
    const f = parseDumpFixture('');
    expect(f.coldStart).toBeUndefined();
  });
});
