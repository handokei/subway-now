/**
 * #2241 (Epic #1927 G4 Phase 0, ADR-030 §Replay harness backbone P0-2) — rawSignalCycleParser 단위 테스트.
 */
import { parseRawSignalCycles } from '../rawSignalCycleParser';

function wrapSection(bodyLines: string[], header = '## Raw Signal (99)'): string {
  return `${header}\n${bodyLines.join('\n')}\n`;
}

describe('parseRawSignalCycles', () => {
  it('섹션 부재 → 빈 배열', () => {
    expect(parseRawSignalCycles('## Other\nfoo=bar\n')).toEqual([]);
  });

  it('헤더에 count 없어도 매칭 (## Raw Signal, 괄호 없음)', () => {
    const dump = wrapSection(
      ['12:00:00 | cycle | 1-020 | gps/gps-only | gps(15m/1.1m/s) | walking | sub=false | arvlCd=- | arc=- | cell=LTE/surface-weak'],
      '## Raw Signal',
    );
    const result = parseRawSignalCycles(dump);
    expect(result).toHaveLength(1);
    expect(result[0].stationId).toBe('1-020');
  });

  it('다음 섹션(## )이 없으면 텍스트 끝까지 파싱 (nextSection === -1 분기)', () => {
    const dump = `## Raw Signal (1)\n12:00:00 | cycle | 1-020 | gps/gps-only | gps(15m/1.1m/s) | walking | sub=false | arvlCd=- | arc=- | cell=LTE/surface-weak`;
    expect(parseRawSignalCycles(dump)).toHaveLength(1);
  });

  it('다음 섹션이 있으면 그 앞까지만 파싱 (nextSection 발견 분기)', () => {
    const dump = `## Raw Signal (1)\n12:00:00 | cycle | 1-020 | gps/gps-only | gps(15m/1.1m/s) | walking | sub=false | arvlCd=- | arc=- | cell=LTE/surface-weak\n## Other\nnoise=1\n`;
    expect(parseRawSignalCycles(dump)).toHaveLength(1);
  });

  it('파싱 불가 라인(10토큰 미만)은 skip', () => {
    const dump = wrapSection(['12:00:00 | cycle | too-short']);
    expect(parseRawSignalCycles(dump)).toEqual([]);
  });

  it('빈 줄은 skip', () => {
    const dump = wrapSection([
      '',
      '  ',
      '12:00:00 | cycle | 1-020 | gps/gps-only | gps(15m/1.1m/s) | walking | sub=false | arvlCd=- | arc=- | cell=LTE/surface-weak',
    ]);
    expect(parseRawSignalCycles(dump)).toHaveLength(1);
  });

  it('kind가 cycle/enter/exit 이외면 skip', () => {
    const dump = wrapSection([
      '12:00:00 | weird | 1-020 | gps/gps-only | gps(15m/1.1m/s) | walking | sub=false | arvlCd=- | arc=- | cell=LTE/surface-weak',
    ]);
    expect(parseRawSignalCycles(dump)).toEqual([]);
  });

  it('시간 형식이 HH:MM:SS가 아니면 skip', () => {
    const dump = wrapSection([
      '25:99 | cycle | 1-020 | gps/gps-only | gps(15m/1.1m/s) | walking | sub=false | arvlCd=- | arc=- | cell=LTE/surface-weak',
    ]);
    expect(parseRawSignalCycles(dump)).toEqual([]);
  });

  it('gps 토큰이 정규식에 안 맞으면 accM/speedMps 둘 다 null', () => {
    const dump = wrapSection([
      '12:00:00 | cycle | 1-020 | gps/gps-only | malformed | walking | sub=false | arvlCd=- | arc=- | cell=LTE/surface-weak',
    ]);
    const [entry] = parseRawSignalCycles(dump);
    expect(entry.accM).toBeNull();
    expect(entry.speedMps).toBeNull();
  });

  it('gps(-/-) → accM/speedMps 둘 다 null', () => {
    const dump = wrapSection([
      '12:00:00 | cycle | - | -/- | gps(-/-) | - | sub=— | arvlCd=- | arc=- | cell=-',
    ]);
    const [entry] = parseRawSignalCycles(dump);
    expect(entry.stationId).toBeNull();
    expect(entry.source).toBeNull();
    expect(entry.confidence).toBeNull();
    expect(entry.motion).toBeNull();
    expect(entry.accM).toBeNull();
    expect(entry.speedMps).toBeNull();
    expect(entry.subsurface).toBeNull();
    expect(entry.arvlCd).toBeNull();
    expect(entry.arcProgress).toBeNull();
    expect(entry.cellularTech).toBeNull();
    expect(entry.cellularVote).toBeNull();
  });

  it('gps(19m/-) → accM만 파싱, speed는 - → null', () => {
    const dump = wrapSection([
      '12:00:00 | cycle | 7-015 | gps/gps-only | gps(19m/-) | unknown | sub=false | arvlCd=99 | arc=- | cell=NRNSA/surface-weak-nrnsa',
    ]);
    const [entry] = parseRawSignalCycles(dump);
    expect(entry.accM).toBe(19);
    expect(entry.speedMps).toBeNull();
  });

  it('gps(23m/3.2m/s) → accM/speedMps 둘 다 파싱', () => {
    const dump = wrapSection([
      '12:00:00 | cycle | 6-002 | gps/gps-only | gps(23m/3.2m/s) | walking | sub=false | arvlCd=99 | arc=- | cell=LTE/surface-weak',
    ]);
    const [entry] = parseRawSignalCycles(dump);
    expect(entry.accM).toBe(23);
    expect(entry.speedMps).toBeCloseTo(3.2);
  });

  it('sub=true / sub=false / sub=— 세 분기', () => {
    const dump = wrapSection([
      '12:00:02 | cycle | 3-015 | gps/gps-only | gps(30m/-) | walking | sub=true | arvlCd=- | arc=- | cell=-/unknown',
      '12:00:01 | cycle | 3-015 | gps/gps-only | gps(30m/-) | walking | sub=false | arvlCd=- | arc=- | cell=-/unknown',
      '12:00:00 | cycle | 3-015 | gps/gps-only | gps(30m/-) | walking | sub=— | arvlCd=- | arc=- | cell=-/unknown',
    ]);
    const results = parseRawSignalCycles(dump);
    expect(results.map((r) => r.subsurface)).toEqual([null, false, true]);
  });

  it('arvlCd=0 (falsy 값 회귀 방지) → 0으로 파싱', () => {
    const dump = wrapSection([
      '12:00:00 | cycle | 3-021 | arrival/arrival-confirmed | gps(70m/-) | walking | sub=false | arvlCd=0 | arc=11480.50 | cell=NRNSA/surface-weak-nrnsa',
    ]);
    const [entry] = parseRawSignalCycles(dump);
    expect(entry.arvlCd).toBe(0);
    expect(entry.arcProgress).toBeCloseTo(11480.5);
  });

  it('arvlCd 값이 파싱 불가(NaN)면 null', () => {
    const dump = wrapSection([
      '12:00:00 | cycle | 7-015 | gps/gps-only | gps(19m/-) | unknown | sub=false | arvlCd=NaNtoken | arc=- | cell=NRNSA/surface-weak-nrnsa',
    ]);
    const [entry] = parseRawSignalCycles(dump);
    expect(entry.arvlCd).toBeNull();
  });

  it('arvlCd 값이 빈 문자열이면 null', () => {
    const dump = wrapSection([
      '12:00:00 | cycle | 7-015 | gps/gps-only | gps(19m/-) | unknown | sub=false | arvlCd= | arc=- | cell=NRNSA/surface-weak-nrnsa',
    ]);
    const [entry] = parseRawSignalCycles(dump);
    expect(entry.arvlCd).toBeNull();
  });

  it('cell=- → tech/vote 둘 다 null', () => {
    const dump = wrapSection([
      '12:00:00 | cycle | - | gps/gps-only | gps(-/-) | - | sub=— | arvlCd=- | arc=- | cell=-',
    ]);
    const [entry] = parseRawSignalCycles(dump);
    expect(entry.cellularTech).toBeNull();
    expect(entry.cellularVote).toBeNull();
  });

  it('cell 값에 슬래시가 없으면 tech=null, vote=값 그대로', () => {
    const dump = wrapSection([
      '12:00:00 | cycle | - | gps/gps-only | gps(-/-) | - | sub=— | arvlCd=- | arc=- | cell=onlyvote',
    ]);
    const [entry] = parseRawSignalCycles(dump);
    expect(entry.cellularTech).toBeNull();
    expect(entry.cellularVote).toBe('onlyvote');
  });

  it('cell= (슬래시도 없고 값도 빈 문자열) → tech/vote 둘 다 null', () => {
    const dump = wrapSection([
      '12:00:00 | cycle | - | gps/gps-only | gps(-/-) | - | sub=— | arvlCd=- | arc=- | cell=',
    ]);
    const [entry] = parseRawSignalCycles(dump);
    expect(entry.cellularTech).toBeNull();
    expect(entry.cellularVote).toBeNull();
  });

  it('cell=/vote (tech 빈 문자열) → tech null, vote만 파싱', () => {
    const dump = wrapSection([
      '12:00:00 | cycle | - | gps/gps-only | gps(-/-) | - | sub=— | arvlCd=- | arc=- | cell=/onlyvote',
    ]);
    const [entry] = parseRawSignalCycles(dump);
    expect(entry.cellularTech).toBeNull();
    expect(entry.cellularVote).toBe('onlyvote');
  });

  it('cell=TECH/ (vote 빈 문자열) → vote null, tech만 파싱', () => {
    const dump = wrapSection([
      '12:00:00 | cycle | - | gps/gps-only | gps(-/-) | - | sub=— | arvlCd=- | arc=- | cell=LTE/',
    ]);
    const [entry] = parseRawSignalCycles(dump);
    expect(entry.cellularTech).toBe('LTE');
    expect(entry.cellularVote).toBeNull();
  });

  it('cell=NRNSA/surface-weak-nrnsa → tech/vote 모두 파싱', () => {
    const dump = wrapSection([
      '12:00:00 | cycle | 7-015 | gps/gps-only | gps(19m/-) | unknown | sub=false | arvlCd=99 | arc=- | cell=NRNSA/surface-weak-nrnsa',
    ]);
    const [entry] = parseRawSignalCycles(dump);
    expect(entry.cellularTech).toBe('NRNSA');
    expect(entry.cellularVote).toBe('surface-weak-nrnsa');
  });

  it('hpa/fix 토큰 부재(구 dump 포맷) → barometerHpa/gpsFixAtMs null', () => {
    const dump = wrapSection([
      '12:00:00 | cycle | 7-015 | gps/gps-only | gps(19m/-) | unknown | sub=false | arvlCd=99 | arc=- | cell=NRNSA/surface-weak-nrnsa',
    ]);
    const [entry] = parseRawSignalCycles(dump);
    expect(entry.barometerHpa).toBeNull();
    expect(entry.gpsFixAtMs).toBeNull();
  });

  it('hpa=-/fix=- (신 포맷이지만 값 없음) → null', () => {
    const dump = wrapSection([
      '12:00:00 | cycle | 7-015 | gps/gps-only | gps(19m/-) | unknown | sub=false | arvlCd=99 | arc=- | cell=NRNSA/surface-weak-nrnsa | hpa=- | fix=-',
    ]);
    const [entry] = parseRawSignalCycles(dump);
    expect(entry.barometerHpa).toBeNull();
    expect(entry.gpsFixAtMs).toBeNull();
  });

  it('hpa/fix 값 채워짐 → 파싱', () => {
    const dump = wrapSection([
      '12:00:05 | cycle | 7-015 | gps/gps-only | gps(19m/-) | unknown | sub=false | arvlCd=99 | arc=- | cell=NRNSA/surface-weak-nrnsa | hpa=1013.2 | fix=12:00:00',
    ]);
    const [entry] = parseRawSignalCycles(dump);
    expect(entry.barometerHpa).toBeCloseTo(1013.2);
    // ts와 같은 날짜로 rebase되어 절대 epoch(자정 기준 0시부터 12:00:00)로 파싱된다.
    expect(entry.gpsFixAtMs).toBe(12 * 3600_000);
  });

  it('dump는 최신이 먼저(reverse) → 시간순(과거→최근)으로 재정렬', () => {
    const dump = wrapSection([
      '12:00:10 | cycle | 1-020 | gps/gps-only | gps(15m/1.1m/s) | walking | sub=false | arvlCd=- | arc=- | cell=LTE/surface-weak',
      '12:00:05 | cycle | 1-020 | gps/gps-only | gps(15m/1.1m/s) | walking | sub=false | arvlCd=- | arc=- | cell=LTE/surface-weak',
      '12:00:00 | cycle | 1-020 | gps/gps-only | gps(15m/1.1m/s) | walking | sub=false | arvlCd=- | arc=- | cell=LTE/surface-weak',
    ]);
    const results = parseRawSignalCycles(dump);
    expect(results.map((r) => r.ts)).toEqual([
      12 * 3600_000,
      12 * 3600_000 + 5_000,
      12 * 3600_000 + 10_000,
    ]);
  });

  it('자정 역행 감지 시 dayBase +1일 전진 (날짜 부재 보정)', () => {
    // dump 순서(최신 먼저): 00:00:10(다음날) → 23:59:50(전날). reverse 후 시간순은
    // 23:59:50 → 00:00:10로, 뒤 항목이 앞보다 시:분:초가 작아 자정을 넘겼다고 판단해야 한다.
    const dump = wrapSection([
      '00:00:10 | cycle | 1-020 | gps/gps-only | gps(15m/-) | - | sub=false | arvlCd=- | arc=- | cell=LTE/surface-weak',
      '23:59:50 | cycle | 1-020 | gps/gps-only | gps(15m/-) | - | sub=false | arvlCd=- | arc=- | cell=LTE/surface-weak',
    ]);
    const results = parseRawSignalCycles(dump);
    const DAY_MS = 24 * 60 * 60 * 1000;
    expect(results[0].ts).toBe(23 * 3600_000 + 59 * 60_000 + 50_000);
    expect(results[1].ts).toBe(DAY_MS + 10_000);
  });

  it('fixAtMs도 자정 역행 시 같은 dayBase로 재계산', () => {
    const dump = wrapSection([
      '00:00:10 | cycle | 1-020 | gps/gps-only | gps(15m/-) | - | sub=false | arvlCd=- | arc=- | cell=LTE/surface-weak | hpa=1010.0 | fix=00:00:05',
      '23:59:50 | cycle | 1-020 | gps/gps-only | gps(15m/-) | - | sub=false | arvlCd=- | arc=- | cell=LTE/surface-weak | hpa=1010.0 | fix=23:59:45',
    ]);
    const results = parseRawSignalCycles(dump);
    const DAY_MS = 24 * 60 * 60 * 1000;
    expect(results[0].gpsFixAtMs).toBe(23 * 3600_000 + 59 * 60_000 + 45_000);
    expect(results[1].gpsFixAtMs).toBe(DAY_MS + 5_000);
  });
});
