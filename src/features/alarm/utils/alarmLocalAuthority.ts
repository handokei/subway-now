/**
 * AlarmLocalAuthority (#2067, Phase 2-device) — 로컬 알람 경로(TTS/진동)의 단일 진입점.
 *
 * 배경: 알람 배너(visible)는 원격(Phase 2-backend)이 주 채널을 담당하므로, device는 배너를
 * 생성하지 않는다. 남는 로컬 역할은 "앱이 깨어있을 때 TTS/진동으로 소리를 보강"뿐이다
 * (PR #2067 comment — 원격 alarm visible push는 FG에서 `shouldPlaySound`가
 * `identifier === ALARM_NOTIFICATION_ID`일 때만 true라 auto-gen identifier인 원격 push는
 * FG에서 무음. companion 수신 시 TTS+진동으로 소리를 보장한다).
 *
 * 정책 gate: sleepMode가 켜져 있을 때만 동작한다 — 스펙상 알람은 취침모드 전용.
 * dedup: AsyncStorage 기반 persisted ledger (TTL 1h) — silentPushTask의 기존 in-memory Set과
 * 달리 앱 재시작(cold-launch) 후에도 dedup 상태가 살아남는다.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ALARM_LOCAL_LEDGER_KEY, SLEEP_MODE_KEY } from '../../../shared/constants/storageKeys';
import { vibrateAlarm } from './alarmSound';
import { speakAlarm } from './tts';
import { createLogger } from '../../../shared/utils/logger';

const logger = createLogger('AlarmLocalAuthority');

/** ledger entry TTL — 1시간. trip 하나가 이보다 길게 이어지는 경우는 드물다. */
export const ALARM_LOCAL_LEDGER_TTL_MS = 60 * 60 * 1000;

export type AlarmLocalKind = 'transfer' | 'destination';

/**
 * 결정적 identifier 생성기 — `alarm-<tripToken>-<station>-<kind>`.
 * ledger dedup key로 사용된다. #2089(스케줄러 통합)에서 OS 예약 identifier로도 재사용 예정.
 */
export function buildAlarmLocalId(
  tripToken: string,
  station: string,
  kind: AlarmLocalKind,
): string {
  return `alarm-${tripToken}-${station}-${kind}`;
}

interface AlarmLocalLedgerEntry {
  id: string;
  firedAt: number;
}

async function readLedger(): Promise<AlarmLocalLedgerEntry[]> {
  try {
    const raw = await AsyncStorage.getItem(ALARM_LOCAL_LEDGER_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is AlarmLocalLedgerEntry =>
        typeof e === 'object' &&
        e !== null &&
        typeof (e as AlarmLocalLedgerEntry).id === 'string' &&
        typeof (e as AlarmLocalLedgerEntry).firedAt === 'number',
    );
  } catch {
    return [];
  }
}

async function writeLedger(entries: AlarmLocalLedgerEntry[]): Promise<void> {
  try {
    await AsyncStorage.setItem(ALARM_LOCAL_LEDGER_KEY, JSON.stringify(entries));
  } catch (e) {
    logger.error('ledger write 실패:', e);
  }
}

function pruneExpired(
  entries: AlarmLocalLedgerEntry[],
  now: number,
): AlarmLocalLedgerEntry[] {
  return entries.filter((e) => now - e.firedAt < ALARM_LOCAL_LEDGER_TTL_MS);
}

/** ledger에 id가 이미 존재하는지(만료되지 않은 항목만) 확인. */
export async function hasFiredLocally(id: string, now: number = Date.now()): Promise<boolean> {
  const entries = pruneExpired(await readLedger(), now);
  return entries.some((e) => e.id === id);
}

async function markFiredLocally(id: string, now: number = Date.now()): Promise<void> {
  const entries = pruneExpired(await readLedger(), now);
  entries.push({ id, firedAt: now });
  await writeLedger(entries);
}

async function readSleepMode(): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(SLEEP_MODE_KEY);
    if (!raw) return false;
    return JSON.parse(raw) === true;
  } catch {
    return false;
  }
}

export interface FireCompanionAlarmParams {
  tripToken: string;
  station: string;
  kind: AlarmLocalKind;
  /** TTS로 읽을 본문. */
  body: string;
}

export type FireCompanionAlarmSkipReason = 'not-sleep-mode' | 'dedup';

export interface FireCompanionAlarmResult {
  fired: boolean;
  reason?: FireCompanionAlarmSkipReason;
}

/**
 * companion silent push(kind `sleep-alarm-companion`) 수신 시 호출되는 단일 진입점.
 *
 * 절차:
 *   1. sleepMode gate — off면 skip (일반 모드는 로컬 알람 0건 정책).
 *   2. ledger dedup — 이미 발사된 id면 skip (backend retry 등으로 인한 중복 방지).
 *   3. ledger 등록 → vibrateAlarm(repeat) + speakAlarm(강제 발화) — 알림(배너) 생성 없음.
 *
 * speakAlarm은 `sleepMode: false`로 호출한다 — tts.ts의 게이트 의미가 "실제 기기 취침 여부"가
 * 아니라 "이 경로가 TTS를 원하는가"이기 때문(sendAlarmNotification 관례: sleepMode=true일 때
 * 원래는 loud alarm.wav가 대신 소리를 낸다). companion 경로는 배너/사운드가 없으므로 TTS가
 * 유일한 음성 신호라 항상 발화해야 한다.
 */
export async function fireCompanionAlarm(
  params: FireCompanionAlarmParams,
): Promise<FireCompanionAlarmResult> {
  const sleepMode = await readSleepMode();
  if (!sleepMode) {
    return { fired: false, reason: 'not-sleep-mode' };
  }

  const id = buildAlarmLocalId(params.tripToken, params.station, params.kind);
  if (await hasFiredLocally(id)) {
    return { fired: false, reason: 'dedup' };
  }

  await markFiredLocally(id);
  vibrateAlarm(true);
  speakAlarm(params.body, { sleepMode: false, allowSpeaker: true });
  logger.info(`companion alarm fired: id=${id}`);
  return { fired: true };
}

/** 테스트 전용 — ledger를 비운다. production 코드에서는 호출하지 않는다. */
export async function __resetAlarmLocalLedgerForTest(): Promise<void> {
  await AsyncStorage.removeItem(ALARM_LOCAL_LEDGER_KEY);
}
