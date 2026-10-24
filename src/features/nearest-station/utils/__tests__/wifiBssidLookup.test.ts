import { lookupStationByBssid, normalizeBssid } from '../wifiBssidLookup';

describe('normalizeBssid', () => {
  it.each([
    ['AA:BB:CC:DD:EE:FF', 'aa:bb:cc:dd:ee:ff'],
    ['aa-bb-cc-dd-ee-ff', 'aa:bb:cc:dd:ee:ff'],
    ['AABBCCDDEEFF', 'aa:bb:cc:dd:ee:ff'],
    ['aa:bb:cc:dd:ee:ff', 'aa:bb:cc:dd:ee:ff'],
  ])('"%s" → "%s" (colon-form normalize)', (input, expected) => {
    expect(normalizeBssid(input)).toBe(expected);
  });

  it.each([['short'], ['toolonghex0123456789'], ['xyz'], [''], ['gg:hh:ii:jj:kk:ll']])(
    '잘못된 form은 빈 문자열 ("%s")',
    (input) => {
      expect(normalizeBssid(input)).toBe('');
    },
  );

  it.each([[null], [undefined], [42], [{}]])('비문자열 → 빈 문자열 (%p)', (input) => {
    expect(normalizeBssid(input as unknown as string)).toBe('');
  });
});

describe('lookupStationByBssid', () => {
  // 실제 BSSID 1건을 dataset에서 동적으로 픽업해 회귀 점검
  // #1481 — slim CSV 적용 후 dataset entry는 stationName/line만 보존 (ssid 컬럼 제거)
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const dataset = require('../../../../data/subwayWifiBssidMap.json') as {
    entries: Record<string, { stationName: string; line: string }>;
  };
  const firstBssid = Object.keys(dataset.entries)[0];
  const firstEntry = dataset.entries[firstBssid];

  it('실제 dataset의 BSSID → Station + line 정확히 반환', () => {
    const result = lookupStationByBssid(firstBssid);
    expect(result).not.toBeNull();
    expect(result?.line).toBe(firstEntry.line);
    expect(result?.station.line).toBe(firstEntry.line);
    expect(result?.station.name).toBe(firstEntry.stationName);
    expect(typeof result?.station.lat).toBe('number');
    expect(typeof result?.station.lng).toBe('number');
  });

  it('대문자 BSSID 입력도 매칭 (case-insensitive)', () => {
    const upper = firstBssid.toUpperCase();
    const result = lookupStationByBssid(upper);
    expect(result?.station.name).toBe(firstEntry.stationName);
  });

  it('dash form BSSID도 매칭', () => {
    const dashed = firstBssid.replace(/:/g, '-');
    expect(lookupStationByBssid(dashed)?.line).toBe(firstEntry.line);
  });

  it.each([
    ['ff:ff:ff:ff:ff:ff', '미등록 BSSID'],
    ['', 'empty'],
    ['not-a-mac', 'invalid form'],
  ])('"%s" (%s) → null', (input) => {
    expect(lookupStationByBssid(input)).toBeNull();
  });

  it('null/undefined 입력 → null (방어적)', () => {
    expect(lookupStationByBssid(null)).toBeNull();
    expect(lookupStationByBssid(undefined)).toBeNull();
    expect(lookupStationByBssid(123 as unknown as string)).toBeNull();
  });

  it('환승역에서도 dataset의 line이 station.line으로 덮어쓰여 platform 정답을 반환', () => {
    // 왕십리는 2/5/bundang 3개 platform — 각각 다른 BSSID로 다른 line이 와야 함.
    const wangsimni = Object.entries(dataset.entries).filter(
      ([, v]) => v.stationName === '왕십리',
    );
    const lines = new Set(wangsimni.map(([, v]) => v.line));
    expect(lines.size).toBeGreaterThanOrEqual(2);
    for (const [bssid, meta] of wangsimni.slice(0, 3)) {
      const result = lookupStationByBssid(bssid);
      expect(result?.station.line).toBe(meta.line);
    }
  });

  it('dataset entry의 stationName이 stations.json에 없으면 null (정합성 가드)', () => {
    jest.isolateModules(() => {
      jest.doMock('../../../../shared/utils/stationLookup', () => ({
        findStationByName: () => null,
      }));
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('../wifiBssidLookup');
      expect(mod.lookupStationByBssid(firstBssid)).toBeNull();
    });
  });
});
