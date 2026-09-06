import { resolveDisplayOrigin } from '../resolveDisplayOrigin';
import type { Station } from '../../../../shared/types/station';

const ddukseom: Station = {
  id: '0210',
  name: '뚝섬',
  line: '2',
  lineColor: '#009D3E',
  lat: 37.53,
  lng: 127.04,
};

const jamsil: Station = {
  id: '0216',
  name: '잠실',
  line: '2',
  lineColor: '#009D3E',
  lat: 37.51,
  lng: 127.1,
};

describe('resolveDisplayOrigin', () => {
  // R2 repro (corrected direction, #2454): fused cascade `result` is stuck at the trip
  // origin(뚝섬) — off-arc, currentStationDisplayDemoted=true — while raw GPS liveResult
  // reports the user's real position(잠실). The displayed name must follow reality(잠실),
  // not freeze at the stale cascade value.
  it('follows raw-GPS reality (liveStation) when the cascade is demoted (stuck/off-arc)', () => {
    const result = resolveDisplayOrigin(ddukseom, jamsil, true, false);
    expect(result).toEqual(jamsil);
  });

  it('falls back to null (honesty placeholder) when demoted and no live GPS reality is available', () => {
    const result = resolveDisplayOrigin(ddukseom, null, true, false);
    expect(result).toBeNull();
  });

  // Must-not-regress: normal on-route trip — cascade not stuck, name tracks effectiveOrigin
  // (the fused/fire-path SSOT) exactly as before, no flicker to raw GPS.
  it('uses effectiveOrigin unchanged when the cascade is not demoted', () => {
    const result = resolveDisplayOrigin(jamsil, ddukseom, false, false);
    expect(result).toEqual(jamsil);
  });

  it('always uses effectiveOrigin for a custom (user-picked) origin, ignoring live GPS and demote state', () => {
    const result = resolveDisplayOrigin(ddukseom, jamsil, true, true);
    expect(result).toEqual(ddukseom);
  });

  it('returns null when effectiveOrigin is null and not demoted', () => {
    expect(resolveDisplayOrigin(null, jamsil, false, false)).toBeNull();
  });
});
