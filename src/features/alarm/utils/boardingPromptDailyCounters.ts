/**
 * #2861 (T2) — Boarding Prompt Acceptance 일별 영속 카운터.
 *
 * root: `computeBoardingPromptMonitor`의 `byDay` 집계는 alarmLog 링(cap=200, 모든 source 혼합)을
 * 매번 재집계한다 — 영속 저장소가 없어 트립 1회만으로도 링이 수 분 내 회전해 지난 일자의
 * displayed/responded/boarded/dismissed가 증발하고, "1주 baseline" acceptance 측정이 사실상
 * "최근 몇 분"으로 쪼그라드는 결함이 있었다(9/30·10/1 실측 수신과 모순되는 "전 일자 0" 거짓
 * 진단의 root, 2026-10-01 trace).
 *
 * fix: displayed/boarded/dismissed를 **쓰기 시점**(`logBoardingPromptFired`/
 * `logBoardingPromptResponded`, alarmLog.ts)에 일자별(`toLocalDayKey`와 동일 규약, 로컬
 * YYYY-MM-DD) 영속 카운터(AsyncStorage)로 적재한다. 링 재집계(`computeBoardingPromptMonitor`)는
 * "최근" 뷰로만 유지 — totals(합계/rate)는 여전히 ring 기반.
 *
 * bucket 분류는 writer가 직접 호출 시점에 안다(fired→displayed, boarded/dismissed→해당 bucket)
 * — `classify()`(boardingPromptMonitor.ts)를 다시 거치지 않는다. 다만 writer가 만드는
 * outcome/reason 리터럴과 `classify()`의 분류 계약이 어긋나면 "최근" 뷰와 "영속" 뷰가 서로 다른
 * bucket을 가리킬 수 있으므로, 계약 일치는 `alarmLog.test.ts`의 교차 테스트로 고정한다.
 *
 * 무한 적재 방지: `BOARDING_PROMPT_DAILY_COUNTERS_RETENTION_DAYS`(14일) 초과 날짜는 매 write
 * 시점에 정리(rolling window) — `firedPushIds.ts`의 TTL prune + 직렬화 write queue 패턴 재사용.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { BOARDING_PROMPT_DAILY_COUNTERS_KEY } from '../../../shared/constants/storageKeys';
import { createLogger } from '../../../shared/utils/logger';
import { toLocalDayKey, type BoardingPromptDayCounts } from './boardingPromptMonitor';

const logger = createLogger('BoardingPromptDailyCounters');

/** 14일 — 1주 baseline 측정(acceptance dashboard 목적)의 2배 여유. */
export const BOARDING_PROMPT_DAILY_COUNTERS_RETENTION_DAYS = 14;

export type BoardingPromptDailyBucket = 'displayed' | 'boarded' | 'dismissed';

type DailyCountersMap = Record<string, BoardingPromptDayCounts>;

function emptyDay(): BoardingPromptDayCounts {
  return { displayed: 0, responded: 0, boarded: 0, dismissed: 0 };
}

async function read(): Promise<DailyCountersMap> {
  try {
    const raw = await AsyncStorage.getItem(BOARDING_PROMPT_DAILY_COUNTERS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as DailyCountersMap;
  } catch {
    return {};
  }
}

/** dayKey는 YYYY-MM-DD ISO 형식이라 문자열 비교가 곧 날짜 비교. */
function prune(map: DailyCountersMap, now: number): DailyCountersMap {
  const cutoffKey = toLocalDayKey(
    now - BOARDING_PROMPT_DAILY_COUNTERS_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  );
  const out: DailyCountersMap = {};
  for (const [dayKey, counts] of Object.entries(map)) {
    if (dayKey >= cutoffKey) out[dayKey] = counts;
  }
  return out;
}

// 모듈 스코프 write 큐 — firedPushIds.ts와 동일 패턴. read-modify-write race로 동시 호출 중
// 한쪽 증가분이 유실되는 것을 막는다(짧은 간격 fired+responded 연속 호출 가능).
let writeQueue: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const next = writeQueue.then(task);
  writeQueue = next;
  return next;
}

/**
 * bucket 1건을 오늘(ts 기준 로컬 날짜) 카운터에 +1. displayed 외 bucket(boarded/dismissed)은
 * responded도 함께 +1 — `computeBoardingPromptMonitor`의 ring 집계와 동일 합산 규칙.
 */
export function recordBoardingPromptDailyCount(
  bucket: BoardingPromptDailyBucket,
  ts: number = Date.now(),
): Promise<void> {
  return enqueue(async () => {
    try {
      const current = await read();
      const pruned = prune(current, ts);
      const dayKey = toLocalDayKey(ts);
      const day = pruned[dayKey] ?? emptyDay();
      day[bucket] += 1;
      if (bucket !== 'displayed') day.responded += 1;
      pruned[dayKey] = day;
      await AsyncStorage.setItem(BOARDING_PROMPT_DAILY_COUNTERS_KEY, JSON.stringify(pruned));
    } catch (e) {
      logger.warn('recordBoardingPromptDailyCount 실패 — 해당 일자 카운트 1건 손실:', e);
    }
  });
}

/** 현재 영속 카운터 전체(day → counts)를 읽는다. 손상/부재는 빈 record. */
export function getBoardingPromptDailyCounters(): Promise<Readonly<DailyCountersMap>> {
  return enqueue(() => read());
}

/** 테스트 전용 — 전체 삭제. */
export function clearBoardingPromptDailyCounters(): Promise<void> {
  return enqueue(async () => {
    try {
      await AsyncStorage.removeItem(BOARDING_PROMPT_DAILY_COUNTERS_KEY);
    } catch (e) {
      logger.warn('clearBoardingPromptDailyCounters 실패:', e);
    }
  });
}

/** 테스트 전용 — write queue 초기화(이전 테스트의 pending task가 다음 테스트로 누수 방지). */
export function _resetBoardingPromptDailyCountersForTests(): void {
  writeQueue = Promise.resolve();
}
