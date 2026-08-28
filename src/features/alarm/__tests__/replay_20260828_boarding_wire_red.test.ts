/**
 * #2405/#2406 — 2026-08-28 실탑승 whole-trip wire fixture (honest verification spike).
 * #2407 — root fix 적용 후 Assertion 1(가설 A/B)을 GREEN으로 flip.
 *
 * 배경: #2405/#2406 — 2026-08-28 실탑승(용마산(7)→중곡→군자→어린이대공원→건대입구(환승
 * 7→2)→성수→뚝섬(2))에서 8개 증상이 발생했는데 CI(type+unit+fixture)는 전부 green이었다.
 * 원인: 기존 unit 테스트가 `tryAutoLock`을 부분 격리(`fetchArrivalsForStation`을 train 반환
 * mock)해 오늘 실패 모드를 재현하지 못했고, fixture replay(#2401 계열)도 fire 로직만 재생해
 * boardingPrompt→lock→estimator wire 자체는 replay하지 않았다.
 *
 * 덤프: `/Users/kimdohan/.claude/uploads/b4fc2a33-498b-4c58-ab8b-14d959d807e5/4dd126ab-827.txt`
 *   - `BoardingLock active=no` — trip 내내 lockless.
 *   - `lockless-trip-end 1:intent`(line 159) — 탑승 프롬프트에 대한 사용자 응답(BOARDED/의향
 *     표명)이 있었음을 시사.
 *   - `06:30:54 | gps-fix | 군자(능동)(5)`(line 468) — 실제 탑승 노선은 7호선인데 raw GPS 최근접
 *     역 판정이 5호선 variant를 채택. `stations.json`에서 군자(능동) 5호선 entry(`5-035`)가
 *     7호선 entry(`7-017`)보다 배열 앞쪽에 있고, 두 variant 좌표가 30m 이내로 근접해 GPS
 *     accuracy(해당 시점 acc=53m) 범위 안에서 뒤집힌다.
 *   - `## Notifications fired`: `06:31:54 fg station-passed 군자(능동) (5)` — 위 오분류가 실제
 *     알림 노선 라벨까지 전파됨을 device 증거로 확인.
 *
 * 본 fixture는 이슈 스펙대로 REAL 체인(mock 금지 대상): `handleResponse`(useBoardingPromptResponder),
 * `useBoardingLockStore.createLock`, `useUserIntentStore`, `useNavigationStore`,
 * `findNearestStation`/`resolveCurrentLine`(stationLookup 계열). mock은 leaf만:
 * `fetchArrivalsForStation`(오늘 지하 조건 재현 — null 또는 line 매칭 0건), AsyncStorage,
 * `expo-notifications`, `dismissBoardingPrompt`(네트워크 POST 경계).
 *
 * #2407 root fix: `tryAutoLock`(useBoardingPromptResponder.ts)이 arrivals null / line 매칭 0건
 * 이어도 더 이상 조기 return하지 않고, trainCode=`PENDING_TRAIN_CODE` sentinel + evidence=false로
 * fallback lock을 생성한다(ADR-014 "명시 탭 = lock 활성과 동급"). 아래 가설 A/B assertion을
 * "lock이 생성되지 않는다"에서 "pending lock이 생성된다"로 flip해 root fix를 실체인으로 증명한다.
 */

const storage = new Map<string, string>();

const mockGetItem = jest.fn((key: string) =>
  Promise.resolve(storage.has(key) ? storage.get(key)! : null),
);
const mockSetItem = jest.fn((key: string, value: string) => {
  storage.set(key, value);
  return Promise.resolve();
});
const mockRemoveItem = jest.fn((key: string) => {
  storage.delete(key);
  return Promise.resolve();
});
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: (...args: [string]) => mockGetItem(...args),
  setItem: (...args: [string, string]) => mockSetItem(...args),
  removeItem: (...args: [string]) => mockRemoveItem(...args),
}));

// leaf — 인프라 경계(iOS 네이티브 SDK, jest 환경에 실물 없음). handleResponse가 참조하는
// DEFAULT_ACTION_IDENTIFIER 상수만 실제 값과 동일하게 제공.
jest.mock('expo-notifications', () => ({
  addNotificationResponseReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
  DEFAULT_ACTION_IDENTIFIER: '$default',
}));

// leaf — 네트워크 POST 경계. dismiss silence 발사 여부만 관측(오토락 성공/실패 분기와 무관).
const mockDismissBoardingPrompt = jest.fn().mockResolvedValue(undefined);
jest.mock('../../nearest-station/api/positionUpload', () => ({
  dismissBoardingPrompt: (...args: unknown[]) => mockDismissBoardingPrompt(...args),
}));

jest.mock('../../../shared/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

import {
  handleResponse,
  type BoardingPromptPayload,
} from '../hooks/useBoardingPromptResponder';
import { BOARDING_PROMPT_ACTION_BOARDED } from '../utils/notificationCategory';
import { useBoardingLockStore } from '../store/useBoardingLockStore';
import { useUserIntentStore } from '../store/useUserIntentStore';
import { useNavigationStore } from '../../route/store/useNavigationStore';
import { findNearestStation } from '../../nearest-station/utils/findNearestStation';
import { resolveCurrentLine } from '../utils/resolveCurrentLine';
import type { StationArrival } from '../../../shared/types/arrival';
import { canonicalStationName } from '../../../testUtils/canonicalStationName';
import { PENDING_TRAIN_CODE } from '../../../shared/constants/boardingLock';

describe('#2405 whole-trip wire RED — 용마산(7) boardingPrompt → tryAutoLock → lock', () => {
  const ORIGIN_STATION = '용마산';
  const LINE = '7';
  const DESTINATION_ID = '2-010'; // 뚝섬(2) — trip 활성 조건(destinationId 존재)을 명시.

  beforeEach(() => {
    jest.clearAllMocks();
    storage.clear();
    useBoardingLockStore.setState({ lock: null });
    useUserIntentStore.setState({ infoModeEnabled: false });
    useNavigationStore.setState({ navigationActive: false });
  });

  function buildPayload(): BoardingPromptPayload {
    return {
      kind: 'boarding-prompt',
      originStation: ORIGIN_STATION,
      line: LINE,
      tripToken: 'trip-2026-08-28',
    };
  }

  async function driveBoardedTap(
    fetchArrivalsForStation: (stationName: string) => Promise<StationArrival | null>,
  ): Promise<void> {
    const createLock = useBoardingLockStore.getState().createLock;
    await handleResponse(BOARDING_PROMPT_ACTION_BOARDED, buildPayload(), {
      fetchArrivalsForStation,
      destinationId: DESTINATION_ID,
      expectedDurationMs: 30 * 60 * 1000,
      createLock,
    });
  }

  it(
    '가설 A(arrivals-null): fetchArrivalsForStation이 null 반환 시 실 tryAutoLock이 pending ' +
      'fallback lock을 생성한다 (GREEN — #2407 root fix 증명)',
    async () => {
      const fetchArrivalsForStation = jest.fn().mockResolvedValue(null);

      await driveBoardedTap(fetchArrivalsForStation);

      expect(fetchArrivalsForStation).toHaveBeenCalledWith(ORIGIN_STATION);
      // 🟢 GREEN 기대(#2407 root fix): train 확정 실패해도 lock은 생성된다 — trainCode는
      // pending sentinel, evidence=false, destinationId/boardingLine은 payload 기반 확정값.
      const { lock } = useBoardingLockStore.getState();
      expect(lock).not.toBeNull();
      expect(lock?.trainCode).toBe(PENDING_TRAIN_CODE);
      expect(lock?.boardingLine).toBe(LINE);
      expect(lock?.destinationId).toBe(DESTINATION_ID);
      expect(lock?.boardingEvidence).toBe(false);
      // 사용자 명시 의향은 그대로 stamp됨 (ADR-014 §X, useBoardingPromptResponder.ts:217-228).
      // 덤프의 `lockless-trip-end 1:intent`와 정합.
      expect(useUserIntentStore.getState().infoModeEnabled).toBe(true);
      expect(useNavigationStore.getState().navigationActive).toBe(true);
    },
  );

  it(
    '가설 B(line-filtered-empty): fetchArrivalsForStation이 다른 노선 후보만 반환 시(7호선 ' +
      '매칭 0건) 실 tryAutoLock이 pending fallback lock을 생성한다 (GREEN — #2407 root fix 증명)',
    async () => {
      // 지하 환경에서 7호선 열차 정보만 API 응답 지연/누락되고 나머지 노선은 응답하는 케이스
      // (환승역 아님에도 payload.line !== 응답 line인 상황을 최소 재현).
      const arrival: StationArrival = {
        up: [
          {
            destination: '성수',
            arrivalMinutes: 1,
            arrivalSeconds: 60,
            statusMessage: '진입',
            trainCode: '2026082699',
            line: '2',
            receivedAtMs: Date.now(),
            arrivalCode: 0,
            isLastTrain: false,
            trainType: 'normal',
          },
        ],
        down: [],
      };
      const fetchArrivalsForStation = jest.fn().mockResolvedValue(arrival);

      await driveBoardedTap(fetchArrivalsForStation);

      // 🟢 GREEN 기대(#2407 root fix): 7호선 매칭 0건이어도 pending fallback lock이 생성된다.
      const { lock } = useBoardingLockStore.getState();
      expect(lock).not.toBeNull();
      expect(lock?.trainCode).toBe(PENDING_TRAIN_CODE);
      expect(lock?.boardingLine).toBe(LINE);
      expect(lock?.boardingEvidence).toBe(false);
    },
  );

  it(
    'GREEN 대조군: 7호선 매칭 단일 후보가 존재하면 실 tryAutoLock이 lock을 정상 생성한다 ' +
      '(오늘 지하 조건이 아닌 정상 케이스 — hypothesis A/B가 진짜 원인임을 대조 확인)',
    async () => {
      const arrival: StationArrival = {
        up: [
          {
            destination: '온수',
            arrivalMinutes: 0,
            arrivalSeconds: 30,
            statusMessage: '출발',
            trainCode: '2026082601',
            line: LINE,
            receivedAtMs: Date.now(),
            arrivalCode: 2,
            isLastTrain: false,
            trainType: 'normal',
          },
        ],
        down: [],
      };
      const fetchArrivalsForStation = jest.fn().mockResolvedValue(arrival);

      await driveBoardedTap(fetchArrivalsForStation);

      const { lock } = useBoardingLockStore.getState();
      expect(lock).not.toBeNull();
      expect(lock?.trainCode).toBe('2026082601');
      expect(lock?.boardingLine).toBe(LINE);
      expect(lock?.destinationId).toBe(DESTINATION_ID);
    },
  );
});

describe('#2405 whole-trip wire RED — 군자(능동) 중간역 line 판정 (증상 3, evidence 06:30:54 gps-fix)', () => {
  // 5호선/7호선 두 platform variant 물리 좌표의 정중앙 — 덤프 evidence(acc=53m)가 보여주는 GPS
  // jitter 범위 안에서 실제로 관측 가능한 fix. stations.json에서 5호선 entry가 배열상 먼저
  // 등록돼 있고(군자(능동) 5호선=`5-035`, 7호선=`7-017`), 이 중점에서 haversine 거리도 5호선이
  // 근소하게 더 가깝다 — 두 조건이 겹쳐 raw 최근접 역 판정이 5호선으로 고정된다.
  const LINE5 = { lat: 37.557088, lng: 127.079577 };
  const LINE7 = { lat: 37.556897, lng: 127.079338 };
  const midpoint = {
    lat: (LINE5.lat + LINE7.lat) / 2,
    lng: (LINE5.lng + LINE7.lng) / 2,
  };

  it(
    'findNearestStation(실체인, mock 없음)이 7호선 탑승 중에도 군자를 5호선으로 판정한다 ' +
      '(RED — 덤프 `06:30:54 | gps-fix | 군자(능동)(5)`와 동일 재현)',
    () => {
      const result = findNearestStation(midpoint.lat, midpoint.lng);

      expect(result).not.toBeNull();
      expect(result?.station.name).toBe(canonicalStationName('군자(능동)', '5'));
      // 🔴 실제 탑승 노선은 7호선인데 raw nearest 판정은 5호선.
      expect(result?.station.line).toBe('5');
    },
  );

  it(
    'resolveCurrentLine(실체인)도 lockless(boardingLine=null)에서는 5호선 오분류를 그대로 ' +
      '전파한다 — 증상3은 증상1(lock 미생성→boardingLine null)의 직접 파생임을 확인',
    () => {
      const nearest = findNearestStation(midpoint.lat, midpoint.lng);
      // Assertion 1이 RED인 실제 trip 조건 그대로: lock이 없으므로 boardingLine=null.
      const currentLine = resolveCurrentLine(null, nearest?.station ?? null);

      expect(currentLine).toBe('5');
      // 대조: lock이 있었다면(boardingLine='7') 이 오분류가 override됐을 것 — resolveCurrentLine.ts
      // 주석("boardingLine 우선 — GPS jitter보다 우선")이 명시하는 정확한 방어선.
      expect(resolveCurrentLine('7', nearest?.station ?? null)).toBe('7');
    },
  );
});

/**
 * #2405 증상 2(lockless-route-hop 원점(idx=0) 재앵커) — TODO, 이 fixture에서 미커버.
 *
 * 덤프 Estimator State에서 `lockless-route-hop 용마산(7) idx=0`가 06:26:39/06:35:55/06:41:28/
 * 06:41:34 네 차례 반복 관측된다(중간에 06:28:08 `중곡(7) idx=1`로 정상 진행한 흔적도 있음) —
 * 순수 시간 적분이라면 단조 증가해야 할 idx가 원점으로 되돌아간 것.
 *
 * `estimateStationProgress`(stationProgressEstimator.ts:398) 자체는 순수 함수라 mock 없이 직접
 * 구동 가능하지만, `tripStartedAt`을 고정하고 `now`만 전진시키면 `hopsElapsedFrom`이 단조 증가만
 * 산출한다(코드 확인) — 즉 estimator 내부 로직 자체는 재앵커를 일으키지 않는다.
 *
 * 실제 원인으로 지목되는 지점(코드 read로 확인, 아직 실체인 구동 미검증):
 * `useFusedNearestStation.ts:1769-1803`의 `locklessTripStartRef`.
 *   - `arcKey = arcStations[0].id|arcStations[last].id` 가 이전 render와 달라지면(line 1778)
 *     `locklessTripStartRef.current = null`로 리셋되고, 다음 effect에서 `Date.now()`(새 시작
 *     시각)로 재초기화된다(line 1786-1790) — 즉 "arc 재계산 = trip 재시작"으로 취급된다.
 *   - 위 군자 5→7호선 오분류(증상3)처럼 route/arc가 GPS jitter로 재계산되면, arcStations[0]이
 *     바뀌지 않아도 재계산 자체가 정체성 다른 배열 인스턴스를 만들 가능성이 있고, 그 경로를
 *     타면 tripStartedAt이 매번 "지금"으로 리셋되어 lockless 적분이 항상 idx=0 근처로 수렴한다.
 *
 * 이 가설을 실체인으로 검증하려면 `useFusedNearestStation`(GPS/arrival/backend-ssot 다중 신호
 * 오케스트레이터, 1800+ 줄) 전체를 renderHook으로 구동해야 하며, 이슈가 명시한 "leaf만 mock"
 * 원칙을 지키려면 GPS/arrival/positionApi 등 다수 leaf를 오늘 덤프 시퀀스 그대로 재생하는 별도
 * fixture가 필요하다 — #2401 계열 fixture(`fusionReplayDriver`)를 확장하는 후속 이슈로 분리
 * 권장. 본 이슈(#2405)는 증상 1·3(핵심 root)의 실체인 검증에 집중했다.
 */
