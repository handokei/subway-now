import AsyncStorage from '@react-native-async-storage/async-storage';
import { BG_DIAGNOSTICS_KEY } from '../constants/storageKeys';
import { createLogger } from './logger';

// #275 진단 카운터. Console.app 접근 없이 앱 내에서 BG 동작 격리를 위해 사용.
// 카운터 키는 closed union으로 고정해 오타로 인한 noise 카운터가 생기지 않게 한다.
export type BgDiagnosticCounter =
  | 'taskFired'
  | 'pipelineEnter'
  | 'pipelineExitNoDestination'
  | 'gateAge'
  | 'gateAccuracy'
  | 'alarmEnter'
  | 'alarmPermDenied'
  | 'stationPassedEnter';

export type BgDiagnostics = Record<BgDiagnosticCounter, number> & { lastTaskFiredTs: number | null };

const EMPTY: BgDiagnostics = {
  taskFired: 0,
  pipelineEnter: 0,
  pipelineExitNoDestination: 0,
  gateAge: 0,
  gateAccuracy: 0,
  alarmEnter: 0,
  alarmPermDenied: 0,
  stationPassedEnter: 0,
  lastTaskFiredTs: null,
};

const logger = createLogger('BgDiagnostics');

// fire-and-forget. 적재 실패가 후속 동작에 영향을 주면 안 됨.
export function incrementBgDiagnostic(counter: BgDiagnosticCounter, options?: { stampTaskFired?: boolean }): void {
  void mutate((current) => {
    const next = { ...current, [counter]: current[counter] + 1 };
    if (options?.stampTaskFired) {
      next.lastTaskFiredTs = Date.now();
    }
    return next;
  });
}

export async function getBgDiagnostics(): Promise<BgDiagnostics> {
  try {
    const raw = await AsyncStorage.getItem(BG_DIAGNOSTICS_KEY);
    if (!raw) return { ...EMPTY };
    const parsed = JSON.parse(raw);
    return { ...EMPTY, ...parsed };
  } catch (e) {
    logger.error('진단 카운터 읽기 실패:', e);
    return { ...EMPTY };
  }
}

export async function clearBgDiagnostics(): Promise<void> {
  try {
    await AsyncStorage.removeItem(BG_DIAGNOSTICS_KEY);
  } catch (e) {
    logger.error('진단 카운터 초기화 실패:', e);
  }
}

// 같은 task wake에서 연속 호출 시 read-modify-write race로 ±1 손실이 생기지
// 않도록 인메모리 promise 체인으로 직렬화한다. 진단 데이터의 정확도가
// 판독 결론에 직결되므로 이 보장이 필요.
let mutateQueue: Promise<void> = Promise.resolve();

async function mutate(updater: (current: BgDiagnostics) => BgDiagnostics): Promise<void> {
  const next = mutateQueue.then(async () => {
    try {
      const current = await getBgDiagnostics();
      const updated = updater(current);
      await AsyncStorage.setItem(BG_DIAGNOSTICS_KEY, JSON.stringify(updated));
    } catch (e) {
      logger.error('진단 카운터 적재 실패:', e);
    }
  });
  mutateQueue = next;
  await next;
}
