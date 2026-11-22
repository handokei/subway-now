/**
 * #3366 — buildDumpText redact 모드. 버그 신고 자동 첨부용 dump에서
 *  (1) 좌표 2곳(`pos=`·GPS 섹션 `lat=,lng=`)을 구조적으로 치환하고
 *  (2) 알려진 token 값을 값 기반으로 전수 `[token:<hashTripToken>]` 치환하며
 *  (3) 최종 문자열에 서버와 같은 패턴 방어 스크럽을 건다.
 * 기본값(redact 미지정)은 기존 출력 불변 — DebugModal.dumpCharacterization.test.ts가 별도로 고정.
 */
import { __test__ } from '../DebugModal';
import { hashTripToken } from '../../../../shared/infra/monitoring/tripTokenHash';
import {
  FIXTURE_ACTIVE_TRIP_TOKEN,
  FIXTURE_APNS_TOKEN,
  FIXTURE_LOCAL_TRIP_ID,
  FIXTURE_NOW_MS,
  makeFixtureDumpArgs,
} from './fixtures/dumpFixture';

jest.mock('../../../alarm/hooks/useSilentPushDiagnostics', () => ({
  useSilentPushDiagnostics: () => ({}),
}));
jest.mock('live-activity', () => ({}));

const { buildDumpText } = __test__;
const TOKENS = [FIXTURE_APNS_TOKEN, FIXTURE_ACTIVE_TRIP_TOKEN, FIXTURE_LOCAL_TRIP_ID];
const tokenMarker = (token: string) => `[token:${hashTripToken(token)}]`;

const KOREA_COORDINATE_CONTEXT =
  /(?:lat|lng|pos)=\s*(?:3[3-9]|1(?:2[4-9]|3[0-2]))\.\d{2,}|(?:3[3-9]\.\d{2,})\s*,\s*(?:1(?:2[4-9]|3[0-2])\.\d{2,})/;

describe('buildDumpText redact 모드 (#3366)', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(FIXTURE_NOW_MS);
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  const redacted = (overrides = {}, tokens: readonly string[] = TOKENS) =>
    buildDumpText(makeFixtureDumpArgs(overrides), { redact: true, tokens });

  describe('기본값 불변', () => {
    it('redact 미지정이면 좌표·token 원문이 그대로 나간다(DebugModal 공유 dump 불변)', () => {
      const dump = buildDumpText(makeFixtureDumpArgs());
      expect(dump).toContain('lat=37.5612345, lng=127.0543216');
      expect(dump).toContain('pos=37.54321,127.05432');
      expect(dump).toContain(FIXTURE_APNS_TOKEN);
      expect(dump).toContain('apnsToken=…e5f60718');
    });

    it('redact: false 명시도 동일', () => {
      expect(buildDumpText(makeFixtureDumpArgs(), { redact: false })).toBe(
        buildDumpText(makeFixtureDumpArgs()),
      );
    });
  });

  describe('구조적 좌표 치환(방어 스크럽이 못 잡는 형태 포함)', () => {
    it('GPS 섹션 raw float 좌표', () => {
      const dump = redacted();
      expect(dump).toContain('lat=[redacted], lng=[redacted], speed=8.5 m/s');
      expect(dump).not.toContain('37.5612345');
      expect(dump).not.toContain('127.0543216');
    });

    it('정수/1자리 소수 경도(`lng=127`)도 구조적으로 치환 — 방어 패턴(소수 2자리 이상)만으로는 못 잡는다', () => {
      const dump = redacted({ userLocation: { lat: 37.55, lng: 127 } });
      expect(dump).toContain('lat=[redacted], lng=[redacted],');
      expect(dump).not.toMatch(/lng=127(?!\d)/);
    });

    it('Raw Signal pos= 좌표', () => {
      const dump = redacted();
      expect(dump).toContain('pos=[redacted]');
      expect(dump).not.toContain('37.54321');
      expect(dump).not.toContain('127.05432');
    });

    it('좌표 없음(`(no location)`, `pos=-`)은 그대로', () => {
      const dump = redacted({ userLocation: null });
      expect(dump).toContain('(no location)');
      expect(dump).toContain('pos=-');
    });

    it('한국 범위 위경도 수치가 문맥 있는 형태로 0건', () => {
      expect(redacted()).not.toMatch(KOREA_COORDINATE_CONTEXT);
    });
  });

  describe('token 값 기반 전수 치환', () => {
    it('Silent Push 섹션의 끝 8자(formatTokenTail)가 hash 마커로', () => {
      const dump = redacted();
      expect(dump).toContain(`apnsToken=${tokenMarker(FIXTURE_APNS_TOKEN)}`);
      expect(dump).toContain(`activeTrip=${tokenMarker(FIXTURE_ACTIVE_TRIP_TOKEN)}`);
      expect(dump).not.toContain('e5f60718');
      expect(dump).not.toContain('1a0b9c8d');
    });

    it('Backend Calls URL `/trips/<token>/`·`/live-activity/<token>`', () => {
      const dump = redacted();
      expect(dump).toContain(`/trips/${tokenMarker(FIXTURE_ACTIVE_TRIP_TOKEN)}/status`);
      expect(dump).toContain(`/live-activity/${tokenMarker(FIXTURE_APNS_TOKEN)}`);
    });

    it('Scheduled queue identifier `alarm-<token>-…`(backend token·device-local id)', () => {
      const dump = redacted();
      expect(dump).toContain(`alarm-${tokenMarker(FIXTURE_ACTIVE_TRIP_TOKEN)}-station-passed-2-212`);
      expect(dump).toContain(`alarm-${tokenMarker(FIXTURE_LOCAL_TRIP_ID)}-destination`);
      expect(dump).not.toContain(FIXTURE_LOCAL_TRIP_ID);
    });

    it('40자 미만 token(32hex)도 값 기반으로 치환 — 방어 패턴(40자 이상)만으로는 못 잡는다', () => {
      const short = '0123456789abcdef0123456789abcdef';
      const dump = buildDumpText(
        makeFixtureDumpArgs({
          silentPush: { ...makeFixtureDumpArgs().silentPush, apnsToken: short },
        }),
        { redact: true, tokens: [short] },
      );
      expect(dump).toContain(`apnsToken=${tokenMarker(short)}`);
      expect(dump).not.toContain('89abcdef');
      expect(dump).not.toContain(short);
    });

    it('원문 token 전부·hex 40자 이상 0건', () => {
      const dump = redacted();
      for (const token of TOKENS) expect(dump).not.toContain(token);
      expect(dump).not.toMatch(/[0-9a-fA-F]{40,}/);
    });

    it('tokens 미전달이어도 Silent Push 입력의 token은 치환(자체 수집)', () => {
      const dump = buildDumpText(makeFixtureDumpArgs(), { redact: true });
      expect(dump).not.toContain(FIXTURE_APNS_TOKEN);
      expect(dump).not.toContain(FIXTURE_ACTIVE_TRIP_TOKEN);
      expect(dump).toContain(`apnsToken=${tokenMarker(FIXTURE_APNS_TOKEN)}`);
    });
  });

  describe('방어 스크럽(알려지지 않은 token·구조 밖 좌표)', () => {
    const UNKNOWN_HEX = 'deadbeef'.repeat(8);

    it('tokens에 없는 64hex → [token]', () => {
      const dump = redacted({
        backendCalls: [
          {
            kind: 'call',
            ts: FIXTURE_NOW_MS,
            callId: 'u1',
            corrId: null,
            url: `https://backend.example/trips/${UNKNOWN_HEX}/sync`,
            method: 'POST',
          },
        ],
      });
      expect(dump).toContain('/trips/[token]/sync');
      expect(dump).not.toContain(UNKNOWN_HEX);
    });

    it('구조 밖(자유 텍스트) 좌표 문맥도 치환', () => {
      const dump = redacted({
        arrivalSummary: 'pos=37.50123,127.01234 / 37.5012345, 127.0123456',
      });
      expect(dump).not.toMatch(KOREA_COORDINATE_CONTEXT);
      expect(dump).toContain('pos=[redacted] / [redacted]');
    });
  });

  describe('오탐 fixture 불변(문맥 조건)', () => {
    it('arc=/acc=/age=/distM= 수치는 치환되지 않는다', () => {
      const dump = redacted({
        arrivalSummary: 'acc=339.39 age=33.375 arc=1128.61 distM=37',
      });
      expect(dump).toContain('acc=339.39 age=33.375 arc=1128.61 distM=37');
      expect(dump).toContain('arc=33.53');
      expect(dump).toContain('arc=4636.57');
    });
  });

  it('치환 외 구조(섹션 헤더 수)는 기본 출력과 동일', () => {
    const headers = (text: string) => text.split('\n').filter((l) => l.startsWith('## '));
    expect(headers(redacted())).toEqual(headers(buildDumpText(makeFixtureDumpArgs())));
  });
});
