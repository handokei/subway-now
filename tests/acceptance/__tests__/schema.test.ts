/**
 * trip-ground-truth.schema 단위 테스트 (P0-4 / #1580).
 *
 * 모든 validator 분기 + parseTripGroundTruth throw/return path 커버.
 */

import {
  parseTripGroundTruth,
  TripGroundTruth,
  validateTripGroundTruth,
} from '../../fixtures/trip-ground-truth.schema';

const VALID: TripGroundTruth = {
  tripStartedAt: '2026-06-21T08:15:00+09:00',
  tripEndedAt: '2026-06-21T08:50:00+09:00',
  actualStations: [
    {
      stationId: '2-035',
      name: '건대입구',
      arrivedAt: '2026-06-21T08:17:23+09:00',
      departedAt: '2026-06-21T08:17:45+09:00',
    },
  ],
  actualTransfers: [
    {
      fromStationId: '2-022',
      toLineId: '1',
      arrivedAt: '2026-06-21T08:32:10+09:00',
      departedAt: '2026-06-21T08:34:20+09:00',
    },
  ],
  actualDestination: {
    stationId: '1-031',
    name: '종로3가',
    arrivedAt: '2026-06-21T08:48:50+09:00',
  },
  environment: 'underground',
  lineIds: ['2', '1'],
  notes: '출근 trip.',
};

describe('validateTripGroundTruth', () => {
  it('valid fixture는 issue 0건', () => {
    expect(validateTripGroundTruth(VALID)).toEqual([]);
  });

  it('root가 object 아니면 reject', () => {
    expect(validateTripGroundTruth(null)).toContainEqual({
      path: '$',
      message: expect.any(String),
    });
    expect(validateTripGroundTruth('string')).toHaveLength(1);
  });

  it('ISO 형식 위반 catch', () => {
    const issues = validateTripGroundTruth({ ...VALID, tripStartedAt: '2026/06/21' });
    expect(issues.map((i) => i.path)).toContain('tripStartedAt');
  });

  it('actualStations 빈 배열 reject', () => {
    const issues = validateTripGroundTruth({ ...VALID, actualStations: [] });
    expect(issues.map((i) => i.path)).toContain('actualStations');
  });

  it('actualStations가 배열 아니면 reject', () => {
    const issues = validateTripGroundTruth({ ...VALID, actualStations: 'oops' });
    expect(issues.map((i) => i.path)).toContain('actualStations');
  });

  it('actualStations 각 항목 필드 검증', () => {
    const issues = validateTripGroundTruth({
      ...VALID,
      actualStations: [{ stationId: '', name: '', arrivedAt: 'bad', departedAt: 'bad' }],
    });
    const paths = issues.map((i) => i.path);
    expect(paths).toContain('actualStations[0].stationId');
    expect(paths).toContain('actualStations[0].name');
    expect(paths).toContain('actualStations[0].arrivedAt');
    expect(paths).toContain('actualStations[0].departedAt');
  });

  it('actualStations 항목이 object 아니면 reject', () => {
    const issues = validateTripGroundTruth({ ...VALID, actualStations: [null] });
    expect(issues.map((i) => i.path)).toContain('actualStations[0]');
  });

  it('actualTransfers 배열 아니면 reject', () => {
    const issues = validateTripGroundTruth({ ...VALID, actualTransfers: 'no' });
    expect(issues.map((i) => i.path)).toContain('actualTransfers');
  });

  it('actualTransfers 빈 배열 허용', () => {
    const issues = validateTripGroundTruth({ ...VALID, actualTransfers: [] });
    expect(issues).toEqual([]);
  });

  it('actualTransfers 항목 검증', () => {
    const issues = validateTripGroundTruth({
      ...VALID,
      actualTransfers: [{ fromStationId: '', toLineId: '', arrivedAt: 'x', departedAt: 'y' }],
    });
    const paths = issues.map((i) => i.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        'actualTransfers[0].fromStationId',
        'actualTransfers[0].toLineId',
        'actualTransfers[0].arrivedAt',
        'actualTransfers[0].departedAt',
      ]),
    );
  });

  it('actualTransfers 항목이 object 아니면 reject', () => {
    const issues = validateTripGroundTruth({ ...VALID, actualTransfers: ['oops'] });
    expect(issues.map((i) => i.path)).toContain('actualTransfers[0]');
  });

  it('actualDestination object 아니면 reject', () => {
    const issues = validateTripGroundTruth({ ...VALID, actualDestination: null });
    expect(issues.map((i) => i.path)).toContain('actualDestination');
  });

  it('actualDestination 필드 검증', () => {
    const issues = validateTripGroundTruth({
      ...VALID,
      actualDestination: { stationId: '', name: '', arrivedAt: 'bad' },
    });
    const paths = issues.map((i) => i.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        'actualDestination.stationId',
        'actualDestination.name',
        'actualDestination.arrivedAt',
      ]),
    );
  });

  it('environment 잘못된 값 reject', () => {
    const issues = validateTripGroundTruth({ ...VALID, environment: 'space' });
    expect(issues.map((i) => i.path)).toContain('environment');
  });

  it('lineIds 빈 배열 / 비배열 / 빈 문자열 reject', () => {
    expect(validateTripGroundTruth({ ...VALID, lineIds: [] }).map((i) => i.path)).toContain(
      'lineIds',
    );
    expect(validateTripGroundTruth({ ...VALID, lineIds: 'x' }).map((i) => i.path)).toContain(
      'lineIds',
    );
    expect(validateTripGroundTruth({ ...VALID, lineIds: [''] }).map((i) => i.path)).toContain(
      'lineIds',
    );
  });

  it('notes string 아니면 reject. 빈 문자열은 OK', () => {
    expect(validateTripGroundTruth({ ...VALID, notes: 123 }).map((i) => i.path)).toContain(
      'notes',
    );
    expect(validateTripGroundTruth({ ...VALID, notes: '' })).toEqual([]);
  });

  it('숫자가 아닌 invalid ISO date string도 reject', () => {
    const issues = validateTripGroundTruth({
      ...VALID,
      tripStartedAt: '2026-13-99T99:99:99+09:00',
    });
    expect(issues.map((i) => i.path)).toContain('tripStartedAt');
  });
});

describe('parseTripGroundTruth', () => {
  it('valid input을 그대로 반환', () => {
    expect(parseTripGroundTruth(VALID)).toEqual(VALID);
  });

  it('invalid input은 issue 요약과 함께 throw', () => {
    expect(() => parseTripGroundTruth({})).toThrow(/schema 위반/);
  });
});
