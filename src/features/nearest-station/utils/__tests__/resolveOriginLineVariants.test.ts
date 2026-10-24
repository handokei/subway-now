import { resolveOriginLineVariants } from '../resolveOriginLineVariants';
import type { Station } from '../../../../shared/types/station';

const ddukseom: Station = {
  id: '0210',
  name: '뚝섬',
  line: '2',
  lineColor: '#009D3E',
  lat: 37.53,
  lng: 127.04,
};

const jamsilLine2: Station = {
  id: '0216',
  name: '잠실',
  line: '2',
  lineColor: '#009D3E',
  lat: 37.51,
  lng: 127.1,
};

const jamsilLine8: Station = {
  id: '0817',
  name: '잠실',
  line: '8',
  lineColor: '#E6186C',
  lat: 37.51,
  lng: 127.1,
};

describe('resolveOriginLineVariants', () => {
  // R2 repro: fused pipeline stalled → effectiveOrigin fell back to trip origin(뚝섬)
  // while raw GPS variants still report live position(잠실, 2·8호선 transfer).
  it('demotes to a single effectiveOrigin-line badge when raw variants belong to a different station', () => {
    const result = resolveOriginLineVariants(ddukseom, [jamsilLine2, jamsilLine8], false);
    expect(result).toEqual([ddukseom]);
    expect(result.some((s) => s.line === '8')).toBe(false);
  });

  it('keeps the full multi-line transfer badges when raw variants match effectiveOrigin (no regression)', () => {
    const result = resolveOriginLineVariants(jamsilLine2, [jamsilLine2, jamsilLine8], false);
    expect(result).toEqual([jamsilLine2, jamsilLine8]);
  });

  it('returns just effectiveOrigin when raw variants has 0 or 1 entries (non-transfer station)', () => {
    expect(resolveOriginLineVariants(ddukseom, [], false)).toEqual([ddukseom]);
    expect(resolveOriginLineVariants(ddukseom, [ddukseom], false)).toEqual([ddukseom]);
  });

  it('always uses effectiveOrigin alone for custom origin, ignoring raw variants entirely', () => {
    const result = resolveOriginLineVariants(jamsilLine2, [jamsilLine2, jamsilLine8], true);
    expect(result).toEqual([jamsilLine2]);
  });

  it('returns an empty array when effectiveOrigin is null', () => {
    expect(resolveOriginLineVariants(null, [jamsilLine2, jamsilLine8], false)).toEqual([]);
  });
});
