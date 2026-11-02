/**
 * #3055 PR-1 — native LA 버튼 POST가 이미 받은 backend 해소(`resolvedTrainCode`)를 기기 lock에 반영한다.
 *
 * 배경: native intent(`BoardingIntents.swift`)가 boarding-confirm을 직접 POST하고 응답을 App Group
 * `nativePost`에 기록한다(PR-2). 브릿지는 그 응답을 재POST 없이 쓴다 — backend는 이미 그 열차로
 * lock을 만들었고 기기만 모르는 상태다(11/02 19:54:57 실측).
 *
 * invariants.md PENDING 승격 ②(`promotePendingLockFromConfirm`)와의 관계 — 상속 + 선언된 변경:
 *   store lock        | 처리                                                | 대비
 *   ------------------+-----------------------------------------------------+------------------
 *   없음              | **실 lock 생성**(lifecycle `la-native-response`)    | 변경(선언): 부재 no-op → 생성
 *   PENDING           | 교체 안 함 + 관측 로그                              | 상속(혼합 lock 방지)
 *   실 lock 동일      | no-op                                               | 상속
 *   실 lock 상이      | 교체 안 함 + 관측 로그                              | 상속
 * 변경 근거: 이 경로는 handleResponse를 타지 않아(브릿지가 native in-flight 동안 보류) "이번 사이클이 만든
 * PENDING"이라는 소유 대상이 없다. 상속하면 lock 부재 시 no-op이 되어 "탭 → lock" 보장(CLAUDE.md "명시 의향")이
 * 깨진다 — backend lock은 존재하고 기기만 없는 불일치가 확정된다.
 *
 * 위치 모순 가드(`hasPositionContradiction`)는 적용하지 않는다: backend가 이 탭으로 이미 lock한 열차라 기기만
 * 거부하면 불일치가 된다(PENDING 승격 ② 채널에도 위치 가드 없음).
 */
import { isValidLineNumber } from '../../../shared/constants/lineApiNames';
import { isPendingTrainCode } from '../../../shared/constants/boardingLock';
import { findStationByNameAndLine } from '../../../shared/utils/stationLookup';
import { createLogger } from '../../../shared/utils/logger';
import { useBoardingLockStore } from '../store/useBoardingLockStore';
import { useUserIntentStore } from '../store/useUserIntentStore';
import { resumeNavigation } from '../store/tripBoundCleanups';
import { logBoardingPromptResponded } from './alarmLog';
import { readWidgetRefreshContext } from './widgetRefreshContext';

const log = createLogger('applyLaNativeResolution');

type CreateLock = ReturnType<typeof useBoardingLockStore.getState>['createLock'];

export interface LaNativeResolutionDeps {
  createLock: CreateLock;
  /** trip destinationId — null이면 저장된 목적지를 live-read한다(`tryAutoLock`과 동일 cold-start 방어). */
  destinationId: string | null;
  expectedDurationMs: number;
}

/** 테스트·관측용 결과. 브릿지는 값을 분기에 쓰지 않는다. */
export type LaNativeResolutionResult =
  | 'created'
  | 'noop-same'
  | 'ignored-pending'
  | 'ignored-other'
  | 'skipped-no-trip'
  | 'skipped-station'
  | 'failed';

export async function applyLaNativeResolution(
  intent: { originStation: string; line: string },
  resolvedTrainCode: string,
  deps: LaNativeResolutionDeps,
): Promise<LaNativeResolutionResult> {
  const { originStation, line } = intent;
  const station = isValidLineNumber(line) ? findStationByNameAndLine(originStation, line) : null;
  const { lock } = useBoardingLockStore.getState();

  if (lock !== null) {
    if (isPendingTrainCode(lock.trainCode)) {
      log.info(`la-native-response ignored: foreign pending (backend=${resolvedTrainCode})`);
      return 'ignored-pending';
    }
    const isSame =
      lock.trainCode === resolvedTrainCode &&
      lock.boardingLine === line &&
      station !== null &&
      lock.boardingStationId === station.id;
    if (isSame) return 'noop-same';
    log.info(
      `la-native-response ignored: real lock differs local=${lock.trainCode} backend=${resolvedTrainCode}`,
    );
    return 'ignored-other';
  }

  if (station === null) {
    log.info('la-native-response skipped — station lookup failed');
    return 'skipped-station';
  }
  const destinationId = deps.destinationId ?? (await readWidgetRefreshContext()).destination?.id ?? null;
  if (!destinationId) {
    log.info('la-native-response skipped — no trip destination');
    return 'skipped-no-trip';
  }

  // 알림 [탑승] 경로(handleResponse)와 같은 명시 의향 stamp — 이 경로는 handleResponse를 타지 않는다.
  logBoardingPromptResponded({ outcome: 'boarded' });
  void useUserIntentStore.getState().setInfoModeEnabled(true);
  resumeNavigation();
  try {
    await deps.createLock(
      {
        destinationId,
        trainCode: resolvedTrainCode,
        boardingStationId: station.id,
        boardingLine: station.line,
        boardedAt: Date.now(),
        expectedDurationMs: deps.expectedDurationMs,
        // native 응답에는 ETA 관측이 없다 — 지연 칩 기준치 미노출(embed lock과 동일).
        initialEtaSeconds: undefined,
      },
      true,
      'la-native-response',
    );
    return 'created';
  } catch (err) {
    log.warn('la-native-response createLock failed', err as Error);
    return 'failed';
  }
}
