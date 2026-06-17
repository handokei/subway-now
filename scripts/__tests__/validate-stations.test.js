/**
 * validate-stations (#1039) — validate() 순수 함수 + main() CLI smoke 단위 테스트.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  LAT_MIN,
  LAT_MAX,
  LNG_MIN,
  LNG_MAX,
  ADJACENT_DISTANCE_MAX_METERS,
  haversineMeters,
  validate,
  main,
} = require('../validate-stations');

const validStation = (overrides = {}) => ({
  id: '1-001',
  name: '소요산',
  line: '1',
  lineColor: '#0052A4',
  lat: 37.9481,
  lng: 127.061,
  ...overrides,
});

const validTopology = (overrides = {}) => ({
  monotonicLines: ['3'],
  endpoints: { 3: { low: '대화', high: '오금' } },
  ...overrides,
});

describe('validate()', () => {
  it('passes for clean stations + topology', () => {
    // #1397: 인접 거리 sanity가 추가되어 좌표를 인접하게(같은 호선 ≤ 8km) 유지한다.
    const stations = [
      validStation({ id: '3-001', name: '대화', line: '3', lat: 37.50, lng: 127.00 }),
      validStation({ id: '3-002', name: '오금', line: '3', lat: 37.51, lng: 127.01 }),
    ];
    const res = validate({ stations, topology: validTopology() });
    expect(res.errors).toEqual([]);
    expect(res.warnings).toEqual([]);
    expect(res.stationCount).toBe(2);
    expect(res.monotonicLineCount).toBe(1);
  });

  it('flags non-array stations.json', () => {
    const res = validate({ stations: null, topology: validTopology() });
    expect(res.errors[0]).toMatch(/root가 배열이 아님/);
    expect(res.stationCount).toBe(0);
    expect(res.monotonicLineCount).toBe(0);
  });

  it('flags non-object topology', () => {
    const res = validate({ stations: [validStation()], topology: null });
    expect(res.errors[0]).toMatch(/root가 객체가 아님/);
    expect(res.stationCount).toBe(1);
  });

  it('flags non-object station entry', () => {
    const res = validate({ stations: [null], topology: validTopology({ monotonicLines: [] }) });
    expect(res.errors.some((e) => /객체가 아님/.test(e))).toBe(true);
  });

  it('flags missing required string fields', () => {
    const bad = {
      id: '',
      name: '',
      line: '',
      lineColor: '',
      lat: 37,
      lng: 127,
    };
    const res = validate({ stations: [bad], topology: validTopology({ monotonicLines: [] }) });
    expect(res.errors.some((e) => /id가 비어있/.test(e))).toBe(true);
    expect(res.errors.some((e) => /name이 비어있/.test(e))).toBe(true);
    expect(res.errors.some((e) => /line이 비어있/.test(e))).toBe(true);
    expect(res.errors.some((e) => /lineColor가 비어있/.test(e))).toBe(true);
  });

  it('flags lat out of bounds and NaN', () => {
    const tooLow = validate({
      stations: [validStation({ lat: LAT_MIN - 1 })],
      topology: validTopology({ monotonicLines: [] }),
    });
    expect(tooLow.errors.some((e) => /lat이.*범위 밖/.test(e))).toBe(true);

    const tooHigh = validate({
      stations: [validStation({ lat: LAT_MAX + 1 })],
      topology: validTopology({ monotonicLines: [] }),
    });
    expect(tooHigh.errors.some((e) => /lat이.*범위 밖/.test(e))).toBe(true);

    const nan = validate({
      stations: [validStation({ lat: Number.NaN })],
      topology: validTopology({ monotonicLines: [] }),
    });
    expect(nan.errors.some((e) => /lat이.*finite/.test(e))).toBe(true);
  });

  it('flags lng out of bounds', () => {
    const res = validate({
      stations: [validStation({ lng: LNG_MIN - 1 })],
      topology: validTopology({ monotonicLines: [] }),
    });
    expect(res.errors.some((e) => /lng가.*범위 밖/.test(e))).toBe(true);

    const high = validate({
      stations: [validStation({ lng: LNG_MAX + 1 })],
      topology: validTopology({ monotonicLines: [] }),
    });
    expect(high.errors.some((e) => /lng가.*범위 밖/.test(e))).toBe(true);
  });

  it('flags duplicate id', () => {
    const res = validate({
      stations: [validStation({ id: 'dup' }), validStation({ id: 'dup' })],
      topology: validTopology({ monotonicLines: [] }),
    });
    expect(res.errors.some((e) => /id "dup" 중복/.test(e))).toBe(true);
  });

  it('flags monotonic line missing endpoints entry', () => {
    const res = validate({
      stations: [
        validStation({ id: '3-001', name: '대화', line: '3' }),
        validStation({ id: '3-002', name: '오금', line: '3', lat: 37.5, lng: 127.1 }),
      ],
      topology: { monotonicLines: ['3'], endpoints: {} },
    });
    expect(res.errors.some((e) => /endpoints\["3"\] 누락/.test(e))).toBe(true);
  });

  it('flags empty endpoints low/high', () => {
    const res = validate({
      stations: [
        validStation({ id: '3-001', name: '대화', line: '3' }),
        validStation({ id: '3-002', name: '오금', line: '3', lat: 37.5, lng: 127.1 }),
      ],
      topology: { monotonicLines: ['3'], endpoints: { 3: { low: '', high: '' } } },
    });
    expect(res.errors.some((e) => /\.low가 비어있/.test(e))).toBe(true);
    expect(res.errors.some((e) => /\.high가 비어있/.test(e))).toBe(true);
  });

  it('flags monotonic line with <2 stations', () => {
    const res = validate({
      stations: [validStation({ id: '3-001', name: '대화', line: '3' })],
      topology: validTopology(),
    });
    expect(res.errors.some((e) => /1개만 존재/.test(e))).toBe(true);
  });

  it('flags non-array monotonicLines and non-object endpoints', () => {
    const res = validate({
      stations: [validStation()],
      topology: { monotonicLines: 'nope', endpoints: 'nope' },
    });
    expect(res.errors.some((e) => /monotonicLines가 배열이 아님/.test(e))).toBe(true);
    expect(res.errors.some((e) => /endpoints가 객체가 아님/.test(e))).toBe(true);
  });

  it('flags empty string in monotonicLines', () => {
    const res = validate({
      stations: [validStation()],
      topology: { monotonicLines: [''], endpoints: {} },
    });
    expect(res.errors.some((e) => /monotonicLines에 비어있는 항목/.test(e))).toBe(true);
  });

  it('warns on id-sort first/last mismatch with endpoints', () => {
    const res = validate({
      stations: [
        validStation({ id: '3-001', name: '실제첫역', line: '3' }),
        validStation({ id: '3-002', name: '실제마지막', line: '3', lat: 37.5, lng: 127.1 }),
      ],
      topology: validTopology(),
    });
    expect(res.errors).toEqual([]);
    expect(res.warnings.some((w) => /첫 역 "실제첫역".*"대화"/.test(w))).toBe(true);
    expect(res.warnings.some((w) => /마지막 역 "실제마지막".*"오금"/.test(w))).toBe(true);
  });

  it('warns on duplicate name within same line', () => {
    const res = validate({
      stations: [
        validStation({ id: '3-001', name: '대화', line: '3' }),
        validStation({ id: '3-002', name: '대화', line: '3', lat: 37.5, lng: 127.1 }),
        validStation({ id: '3-003', name: '오금', line: '3', lat: 37.5, lng: 127.1 }),
      ],
      topology: validTopology(),
    });
    expect(res.warnings.some((w) => /name "대화"이 2회 중복/.test(w))).toBe(true);
  });

  it('skips name-dup count for stations without name string', () => {
    // dup line name 카운트 분기에서 name이 string이 아닌 경우 continue 경로 — error로 잡히지만 warn은 안 띄움.
    const res = validate({
      stations: [
        validStation({ id: '3-001', name: '대화', line: '3' }),
        validStation({ id: '3-002', name: '', line: '3', lat: 37.5, lng: 127.1 }),
        validStation({ id: '3-003', name: '오금', line: '3', lat: 37.5, lng: 127.1 }),
      ],
      topology: validTopology(),
    });
    // empty name → error, no name-dup warn
    expect(res.errors.some((e) => /name이 비어있/.test(e))).toBe(true);
    expect(res.warnings.every((w) => !/name ".*"이.*중복/.test(w))).toBe(true);
  });

  it('warns when adjacent stops exceed ADJACENT_DISTANCE_MAX_METERS (#1397)', () => {
    // 대화(37.6754, 126.7657) → 오금(37.5022, 127.1276): ≈ 41km 차이 → warning 트리거
    const res = validate({
      stations: [
        validStation({ id: '3-001', name: '대화', line: '3', lat: 37.6754, lng: 126.7657 }),
        validStation({ id: '3-002', name: '오금', line: '3', lat: 37.5022, lng: 127.1276 }),
      ],
      topology: validTopology(),
    });
    expect(res.errors).toEqual([]);
    expect(
      res.warnings.some((w) => /인접 hop "대화" → "오금".*누락된 중간역 의심/.test(w)),
    ).toBe(true);
  });

  it('does not warn when adjacent stops are within tolerance', () => {
    // 인접 짧은 거리 (≈ 1km)
    const res = validate({
      stations: [
        validStation({ id: '3-001', name: '대화', line: '3', lat: 37.50, lng: 127.00 }),
        validStation({ id: '3-002', name: '오금', line: '3', lat: 37.51, lng: 127.00 }),
      ],
      topology: validTopology(),
    });
    expect(res.warnings.every((w) => !/인접 hop/.test(w))).toBe(true);
  });

  it('skips adjacent distance check when coordinates are non-finite', () => {
    // 좌표가 NaN인 경우 — 이미 lat 에러는 다른 룰에서 잡힘. distance 룰은 silently skip.
    const res = validate({
      stations: [
        validStation({ id: '3-001', name: '대화', line: '3', lat: Number.NaN, lng: 127.00 }),
        validStation({ id: '3-002', name: '오금', line: '3', lat: 37.51, lng: 127.00 }),
      ],
      topology: validTopology(),
    });
    expect(res.warnings.every((w) => !/인접 hop/.test(w))).toBe(true);
  });
});

describe('haversineMeters', () => {
  it('동일 좌표는 0', () => {
    expect(haversineMeters(37, 127, 37, 127)).toBe(0);
  });

  it('1도 위도 차이는 ~111km', () => {
    const d = haversineMeters(37, 127, 38, 127);
    expect(d).toBeGreaterThan(110000);
    expect(d).toBeLessThan(112000);
  });

  it('상수가 export됨', () => {
    expect(ADJACENT_DISTANCE_MAX_METERS).toBeGreaterThan(0);
  });
});

describe('main()', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-stations-'));
  const writeJson = (name, data) => {
    const p = path.join(tmpDir, name);
    fs.writeFileSync(p, JSON.stringify(data));
    return p;
  };

  it('returns 0 and prints success summary for valid input', () => {
    const outs = [];
    const errs = [];
    // #1397: 인접 hop sanity 발동 회피 위해 좌표를 인접하게 유지.
    const stationsPath = writeJson('s-ok.json', [
      validStation({ id: '3-001', name: '대화', line: '3', lat: 37.50, lng: 127.00 }),
      validStation({ id: '3-002', name: '오금', line: '3', lat: 37.51, lng: 127.01 }),
    ]);
    const topologyPath = writeJson('t-ok.json', validTopology());
    const code = main([], {
      writeOut: (s) => outs.push(s),
      writeErr: (s) => errs.push(s),
      stationsPath,
      topologyPath,
    });
    expect(code).toBe(0);
    expect(outs.some((s) => /✅ 2 stations OK, 1 monotonic lines OK$/.test(s))).toBe(true);
    expect(errs).toEqual([]);
  });

  it('returns 0 with warning count in summary when warnings present', () => {
    const outs = [];
    // #1397: 인접 hop sanity 발동 회피 위해 좌표 인접 유지. 2 warnings는 endpoints 미스매치 2건.
    const stationsPath = writeJson('s-warn.json', [
      validStation({ id: '3-001', name: '실제첫역', line: '3', lat: 37.50, lng: 127.00 }),
      validStation({ id: '3-002', name: '실제마지막', line: '3', lat: 37.51, lng: 127.01 }),
    ]);
    const topologyPath = writeJson('t-warn.json', validTopology());
    const code = main([], {
      writeOut: (s) => outs.push(s),
      writeErr: () => {},
      stationsPath,
      topologyPath,
    });
    expect(code).toBe(0);
    expect(outs.some((s) => /2 warnings/.test(s))).toBe(true);
  });

  it('returns 1 and prints errors for invalid input', () => {
    const outs = [];
    const errs = [];
    const stationsPath = writeJson('s-bad.json', [validStation({ lat: 999 })]);
    const topologyPath = writeJson('t-bad.json', validTopology({ monotonicLines: [] }));
    const code = main([], {
      writeOut: (s) => outs.push(s),
      writeErr: (s) => errs.push(s),
      stationsPath,
      topologyPath,
    });
    expect(code).toBe(1);
    expect(errs.some((s) => /lat이.*범위 밖/.test(s))).toBe(true);
    expect(errs.some((s) => /^❌ \d+ errors$/.test(s))).toBe(true);
  });

  it('returns 1 when stations.json unreadable', () => {
    const errs = [];
    const code = main([], {
      writeOut: () => {},
      writeErr: (s) => errs.push(s),
      stationsPath: path.join(tmpDir, 'does-not-exist.json'),
      topologyPath: writeJson('t-rd.json', validTopology()),
    });
    expect(code).toBe(1);
    expect(errs.some((s) => /stations\.json 읽기 실패/.test(s))).toBe(true);
  });

  it('returns 1 when lineTopology.json unreadable', () => {
    const errs = [];
    const stationsPath = writeJson('s-rd.json', [validStation()]);
    const code = main([], {
      writeOut: () => {},
      writeErr: (s) => errs.push(s),
      stationsPath,
      topologyPath: path.join(tmpDir, 'does-not-exist-2.json'),
    });
    expect(code).toBe(1);
    expect(errs.some((s) => /lineTopology\.json 읽기 실패/.test(s))).toBe(true);
  });

  it('uses default deps (real stdout/stderr + repo paths) when omitted', () => {
    // SSOT data가 통과해야 한다는 것을 확인 (warnings는 허용).
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    const captured = { out: [], err: [] };
    process.stdout.write = (s) => {
      captured.out.push(String(s));
      return true;
    };
    process.stderr.write = (s) => {
      captured.err.push(String(s));
      return true;
    };
    let code;
    try {
      code = main([]);
    } finally {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    }
    expect(code).toBe(0);
    expect(captured.out.join('')).toMatch(/✅ \d+ stations OK/);
  });
});
