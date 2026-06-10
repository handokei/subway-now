import { getServiceWindow } from '../serviceWindow';

describe('getServiceWindow', () => {
  // KST 시간대 명시. UTC+9 — KST 정오는 UTC 03:00.
  const KST_WEEKDAY_NOON = new Date('2026-06-09T03:00:00.000Z'); // 화요일 12:00 KST
  const KST_SATURDAY_NOON = new Date('2026-06-13T03:00:00.000Z'); // 토요일 12:00 KST
  const KST_SUNDAY_NOON = new Date('2026-06-14T03:00:00.000Z'); // 일요일 12:00 KST

  describe('status="in-service" 분기', () => {
    it('평일 정오는 운행 중', () => {
      const result = getServiceWindow({
        stationName: '소요산',
        line: '1',
        now: KST_WEEKDAY_NOON,
      });
      expect(result.status).toBe('in-service');
      expect(result.firstTrain).toMatch(/^\d{2}:\d{2}$/);
      expect(result.lastTrain).toMatch(/^\d{2}:\d{2}$/);
    });

    it('토요일은 saturday timetable 사용', () => {
      const result = getServiceWindow({
        stationName: '소요산',
        line: '1',
        now: KST_SATURDAY_NOON,
      });
      expect(result.status).toBe('in-service');
    });

    it('일요일은 sunday timetable 사용', () => {
      const result = getServiceWindow({
        stationName: '소요산',
        line: '1',
        now: KST_SUNDAY_NOON,
      });
      expect(result.status).toBe('in-service');
    });

    it('dayType 명시 시 KST 자동 분류를 override', () => {
      // 토요일 정오인데 dayType='weekday' 강제
      const result = getServiceWindow({
        stationName: '소요산',
        line: '1',
        dayType: 'weekday',
        now: KST_SATURDAY_NOON,
      });
      expect(result.status).toBe('in-service');
    });
  });

  describe('status="pre-first" 분기', () => {
    it('overnight 없는 timetable에서 첫차 전은 pre-first (mock으로 검증)', () => {
      // 모든 실제 1~9호선 역은 24h+ 운행을 가지므로 non-overnight 분기는 mock으로 검증.
      jest.isolateModules(() => {
        jest.doMock('../../../../data/timetables/line-1.json', () => ({
          stations: {
            테스트역: {
              weekday: { up: ['0600', '2300'], down: ['0610', '2250'] },
              saturday: { up: ['0600'], down: ['0610'] },
              sunday: { up: ['0600'], down: ['0610'] },
            },
          },
        }));
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { getServiceWindow: build } = require('../serviceWindow');
        // KST 04:00 = UTC 19:00 전날.
        const earlyMorning = new Date('2026-06-08T19:00:00.000Z');
        const result = build({ stationName: '테스트역', line: '1', now: earlyMorning });
        expect(result.status).toBe('pre-first');
        expect(result.firstTrain).toBe('06:00');
        expect(result.lastTrain).toBe('23:00');
      });
      jest.resetModules();
    });

    it('overnight timetable에서 첫차 전(overnight tail 종료 후 ~ 다음 첫차 전)은 post-last로 분류', () => {
      // 소요산: lastRaw=1476(00:36 익일), firstRaw=346(05:46).
      // KST 03:00은 overnight tail(00:36) 이후, 첫차(05:46) 전 → post-last (어제 막차 종료).
      const between = new Date('2026-06-08T18:00:00.000Z'); // 2026-06-09 03:00 KST
      const result = getServiceWindow({
        stationName: '소요산',
        line: '1',
        now: between,
      });
      expect(result.status).toBe('post-last');
    });
  });

  describe('non-overnight timetable post-last 분기', () => {
    it('lastRaw < 1440 timetable에서 막차 후는 post-last (mock으로 검증)', () => {
      jest.isolateModules(() => {
        jest.doMock('../../../../data/timetables/line-1.json', () => ({
          stations: {
            테스트역: {
              weekday: { up: ['0600', '2300'], down: ['0610', '2250'] },
              saturday: { up: ['0600'], down: ['0610'] },
              sunday: { up: ['0600'], down: ['0610'] },
            },
          },
        }));
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { getServiceWindow: build } = require('../serviceWindow');
        // KST 23:30 = UTC 14:30 → 23:00(last) 후.
        const afterLast = new Date('2026-06-09T14:30:00.000Z');
        const result = build({ stationName: '테스트역', line: '1', now: afterLast });
        expect(result.status).toBe('post-last');
      });
      jest.resetModules();
    });

    it('lastRaw < 1440 timetable에서 윈도우 내는 in-service (mock으로 검증)', () => {
      jest.isolateModules(() => {
        jest.doMock('../../../../data/timetables/line-1.json', () => ({
          stations: {
            테스트역: {
              weekday: { up: ['0600', '2300'], down: ['0610', '2250'] },
              saturday: { up: ['0600'], down: ['0610'] },
              sunday: { up: ['0600'], down: ['0610'] },
            },
          },
        }));
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { getServiceWindow: build } = require('../serviceWindow');
        const noon = new Date('2026-06-09T03:00:00.000Z');
        const result = build({ stationName: '테스트역', line: '1', now: noon });
        expect(result.status).toBe('in-service');
      });
      jest.resetModules();
    });
  });

  describe('status="post-last" 분기', () => {
    it('막차 후(소요산 weekday up 마지막은 24:36, KST 02:00은 그 후)', () => {
      // 소요산 weekday lastTrain은 down "2347" / up "2436" → 합치면 raw 1476 (다음날 00:36).
      // KST 03:00은 (1476-1440)=36분보다 늦으므로 post-last (overnight tail 이후).
      const afterLast = new Date('2026-06-09T18:00:00.000Z'); // KST 03:00 화요일 새벽
      const result = getServiceWindow({
        stationName: '소요산',
        line: '1',
        now: afterLast,
      });
      expect(result.status).toBe('post-last');
    });
  });

  describe('status="unknown" 분기', () => {
    it('timetable 없는 노선(공항철도)은 unknown', () => {
      const result = getServiceWindow({
        stationName: '서울역',
        line: 'airport',
        now: KST_WEEKDAY_NOON,
      });
      expect(result).toEqual({ firstTrain: null, lastTrain: null, status: 'unknown' });
    });

    it('timetable에 없는 역은 unknown', () => {
      const result = getServiceWindow({
        stationName: '존재하지않는역',
        line: '1',
        now: KST_WEEKDAY_NOON,
      });
      expect(result).toEqual({ firstTrain: null, lastTrain: null, status: 'unknown' });
    });

    it('모든 슬롯이 "0000"(NON_OPERATING)인 비정상 timetable은 unknown', () => {
      // jest.isolateModules + doMock 으로 line-1.json을 일시 치환.
      jest.isolateModules(() => {
        jest.doMock('../../../../data/timetables/line-1.json', () => ({
          stations: {
            전부미운행: {
              weekday: { up: ['0000', '0000'], down: ['0000'] },
              saturday: { up: ['0000'], down: ['0000'] },
              sunday: { up: ['0000'], down: ['0000'] },
            },
          },
        }));
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { getServiceWindow: build } = require('../serviceWindow');
        const result = build({
          stationName: '전부미운행',
          line: '1',
          now: KST_WEEKDAY_NOON,
        });
        expect(result).toEqual({ firstTrain: null, lastTrain: null, status: 'unknown' });
      });
      jest.resetModules();
    });
  });

  describe('overnight overflow 처리', () => {
    it('막차가 다음날 새벽(24h+)인 역의 overnight tail은 in-service', () => {
      // 소요산 weekday up "2436" → 다음날 00:36 KST.
      // KST 00:20 (2026-06-10 화요일 00:20 = 2026-06-09 15:20 UTC)은 아직 운행 중.
      const overnightTail = new Date('2026-06-09T15:20:00.000Z');
      const result = getServiceWindow({
        stationName: '소요산',
        line: '1',
        now: overnightTail,
      });
      expect(result.status).toBe('in-service');
    });

    it('lastTrain 표시는 24h+ 표기를 "HH:mm"으로 정규화 (소요산 up 2436 → 00:36)', () => {
      const result = getServiceWindow({
        stationName: '소요산',
        line: '1',
        now: KST_WEEKDAY_NOON,
      });
      // 소요산 up 마지막 "2436"이 down 마지막 "2347"보다 늦으므로 lastTrain은 "00:36".
      expect(result.lastTrain).toBe('00:36');
    });

    it('firstTrain은 up/down 합쳐 가장 빠른 실제 운행 entry (소요산 down 0546 vs up 0553 → 05:46)', () => {
      const result = getServiceWindow({
        stationName: '소요산',
        line: '1',
        now: KST_WEEKDAY_NOON,
      });
      expect(result.firstTrain).toBe('05:46');
    });
  });

  describe('now 인자 미지정 시 현재 시각 사용', () => {
    it('now 생략하면 new Date()로 fallback', () => {
      const result = getServiceWindow({ stationName: '소요산', line: '1' });
      // 결정성 없는 분기지만, 호출 자체가 throw하지 않고 4개 status 중 하나 반환하면 OK.
      expect(['pre-first', 'in-service', 'post-last', 'unknown']).toContain(result.status);
    });
  });
});
