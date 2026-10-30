/**
 * #3221 PR-4 — 탑승여부 Live Activity(`BoardingActivityAttributes`) device 채널.
 *
 * 여정 LA(`liveActivityPushChannel.ts`, ADR-049 권위 게이트 D1~D4)와 **별도 ActivityKit 타입**이다.
 * 이 모듈은 의도적으로 여정 채널을 import하지 않는다:
 *   - ADR-049 게이트(`shouldSkipDeviceLiveActivityWrite`)는 여정 writer 전용 — 탑승 writer B1~B4는 게이트 밖.
 *   - ambient listener(`liveActivityPushChannel.ts`)는 여정 `onPushToken`만 구독한다. 탑승 push-to-start
 *     token은 여기서만 받아 trip register body로 보낸다(여정 trip의 LA token으로 등록되지 않는다).
 *   (둘 다 `boardingActivityChannel.test.ts` 텍스트 계약 테스트가 고정한다.)
 *
 * 시작 경로: iOS 17.2+ 는 backend push-to-start가 띄운다(기기는 시작하지 않는다). 17.0~17.1 은 앱 FG에서
 * boarding-prompt silent push를 받았을 때 기기가 시작(B1). 그 외(16.x/LA OFF)는 탑승 LA 없음(일반 알림).
 * 종료 경로: 기기 소유 — 응답 intent(B2) / lock 생성·응답 handler(B3) / trip 종료 cleanup 3곳(B4).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState, Platform } from 'react-native';
import {
  addBoardingPushToStartTokenListener,
  endBoardingActivities,
  isLiveActivityEnabled,
  requestBoardingPushToStartToken,
  startBoardingActivity,
  type BoardingActivityData,
} from 'live-activity';
import { BOARDING_PUSH_TO_START_TOKEN_KEY } from '../../../shared/constants/storageKeys';
import {
  BOARDING_FG_START_MIN_IOS,
  BOARDING_PUSH_TO_START_MIN_IOS,
  BOARDING_UNKNOWN_LINE_COLOR_HEX,
} from '../../../shared/constants/boardingActivity';
import { LINE_COLORS, LINE_NAMES } from '../../../shared/constants/lineColors';
import type { LineNumber } from '../../../shared/types/station';
import { createLogger } from '../../../shared/utils/logger';
import { logBoardingLaWrite } from './alarmLog';

const log = createLogger('boardingActivityChannel');

/** backend `Trip.laClient.boardingStart`(#3238)와 1:1. */
export type BoardingStartMode = 'push-to-start' | 'fg-only' | 'none';

export interface BoardingRegisterFields {
  laClient?: { split: true; boardingStart: BoardingStartMode };
  boardingPushToStartToken?: string;
}

/** 종료 호출처 -> 쓰기 writer ID. 호출처가 하나 늘면 이 표에 먼저 추가한다(편측 방지). */
export const BOARDING_END_WRITER = {
  'intent-response': 'B2',
  'lock-created': 'B3',
  'not-boarded-response': 'B3',
  'hop-end-response': 'B3',
  'trip-cleanup': 'B4',
  'clear-station-notification': 'B4',
  'bg-refresh-dest-absent': 'B4',
} as const;

export type BoardingEndReason = keyof typeof BOARDING_END_WRITER;

interface IosVersion {
  major: number;
  minor: number;
}

function isAtLeast(version: IosVersion, min: IosVersion): boolean {
  return version.major > min.major || (version.major === min.major && version.minor >= min.minor);
}

function readIosVersion(): IosVersion {
  const [major, minor = 0] = String(Platform.Version).split('.').map(Number);
  return { major, minor };
}

/**
 * 이 기기의 탑승 LA 시작 방식. iOS가 아니면 null(LA 개념 없음 -> register에 아무것도 싣지 않는다).
 * LA 사용 설정이 꺼져 있으면 버전과 무관하게 'none'(일반 알림 경로).
 */
export function resolveBoardingStartMode(): BoardingStartMode | null {
  if (Platform.OS !== 'ios') return null;
  if (!isLiveActivityEnabled()) return 'none';
  const version = readIosVersion();
  if (isAtLeast(version, BOARDING_PUSH_TO_START_MIN_IOS)) return 'push-to-start';
  if (isAtLeast(version, BOARDING_FG_START_MIN_IOS)) return 'fg-only';
  return 'none';
}

export async function readBoardingPushToStartToken(): Promise<string | null> {
  return AsyncStorage.getItem(BOARDING_PUSH_TO_START_TOKEN_KEY);
}

/**
 * trip register body에 얹을 조각. push-to-start 모드에서만 token을 싣는다(token 미발급이면 laClient만).
 * 여정 LA token(`registerLiveActivityToken`)과 별개의 필드이며 이 token은 여정 trip의 LA token이 아니다.
 */
export async function buildBoardingRegisterFields(): Promise<BoardingRegisterFields> {
  const boardingStart = resolveBoardingStartMode();
  if (boardingStart === null) return {};
  const laClient = { split: true as const, boardingStart };
  if (boardingStart !== 'push-to-start') return { laClient };
  const token = await readBoardingPushToStartToken();
  return token ? { laClient, boardingPushToStartToken: token } : { laClient };
}

async function cacheBoardingPushToStartToken(token: string, onChange?: () => void): Promise<void> {
  const prev = await readBoardingPushToStartToken();
  if (prev === token) return;
  await AsyncStorage.setItem(BOARDING_PUSH_TO_START_TOKEN_KEY, token);
  onChange?.();
}

/**
 * push-to-start token 발급/회전을 구독해 캐시한다. 값이 **바뀐 경우에만** `onChange`를 호출한다 —
 * 호출자는 활성 trip을 새 token으로 재등록한다(토큰 회전은 드물어 putTrip 증가는 회전당 1회).
 * 앱 수명 동안 1개만 유지한다(호출자가 mount/unmount로 관리).
 */
export function startBoardingPushToStartTokenCapture(onChange?: () => void): () => void {
  if (Platform.OS !== 'ios') return () => undefined;
  const subscription = addBoardingPushToStartTokenListener((event) => {
    cacheBoardingPushToStartToken(event.token, onChange).catch((e) => {
      log.warn('push-to-start token 캐시 실패', e);
    });
  });
  // 리스너 부착 전에 이미 발급된 token(앱 재시작)을 회수한다 — 이벤트는 새 발급/회전에만 온다.
  requestBoardingPushToStartToken()
    .then((token) => (token ? cacheBoardingPushToStartToken(token, onChange) : undefined))
    .catch((e) => {
      log.warn('push-to-start token 조회 실패', e);
    });
  return () => subscription.remove();
}

/**
 * 탑승 LA 종료. 어떤 이유로도 throw하지 않는다(종료 경로가 호출처의 본 작업을 막으면 안 된다).
 * 멱등 — 활성 탑승 LA가 없으면 native가 no-op. 여정 LA는 건드리지 않는다.
 */
export async function endBoardingActivity(reason: BoardingEndReason): Promise<void> {
  if (Platform.OS !== 'ios') return;
  try {
    logBoardingLaWrite({ writer: BOARDING_END_WRITER[reason], source: reason });
    await endBoardingActivities();
  } catch (e) {
    log.warn(`탑승 LA 종료 실패 (${reason})`, e);
  }
}

/** boarding-prompt silent push payload 중 탑승 LA 시작에 쓰는 부분(`silentPushTask`의 payload와 구조 호환). */
export interface BoardingPromptStartInput {
  originStation: string;
  line: string;
  tripToken: string;
  pushId?: string;
  sentAt?: number;
  title?: string;
  body?: string;
  hopEndKind?: 'disembark';
  nextLine?: string;
}

function buildBoardingActivityData(input: BoardingPromptStartInput): BoardingActivityData {
  const { originStation, line, tripToken, pushId, sentAt, title, body, hopEndKind, nextLine } = input;
  const lineKey = line as LineNumber;
  return {
    // 같은 promptId 중복 시작은 native가 no-op 처리한다. pushId가 없으면 같은 발사를 같은 id로 수렴시킨다.
    promptId: pushId ?? `${tripToken}|${originStation}|${sentAt ?? 0}`,
    tripToken,
    phase: hopEndKind === 'disembark' ? 'hop-end' : 'pre-boarding',
    originStation,
    line,
    lineName: LINE_NAMES[lineKey] ?? line,
    lineColorHex: LINE_COLORS[lineKey] ?? BOARDING_UNKNOWN_LINE_COLOR_HEX,
    title: title ?? originStation,
    ...(body ? { body } : {}),
    ...(nextLine ? { nextLine } : {}),
  };
}

/**
 * B1 — iOS 17.0~17.1 에서 boarding-prompt silent push를 **foreground**로 받았을 때 기기가 탑승 LA를 시작한다.
 * 17.2+ 는 서버 push-to-start가 띄우므로 시작하지 않는다(중복 방지), 16.x/LA OFF 는 탑승 LA 없음,
 * BG 는 기기가 LA를 시작할 수 없다(`useEnsureLiveActivity` 불변식). throw하지 않는다.
 */
export async function startBoardingActivityFromPrompt(input: BoardingPromptStartInput): Promise<void> {
  if (resolveBoardingStartMode() !== 'fg-only') return;
  if (AppState.currentState !== 'active') return;
  try {
    await startBoardingActivity(buildBoardingActivityData(input));
    logBoardingLaWrite({ writer: 'B1', source: 'fg-start' });
  } catch (e) {
    log.warn('탑승 LA FG 시작 실패', e);
  }
}
