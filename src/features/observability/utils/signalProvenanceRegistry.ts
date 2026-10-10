/**
 * Signal Provenance Registry — SSoT for "관측 지표 → emitter 심볼" 매핑 (#2250, ADR-029 Phase 3).
 *
 * 왜: 채널/emitter가 은퇴돼도 그걸 measure하던 지표는 조용히 0을 찍으며 살아남아 정상처럼 보인다
 * (`silentPushReach`가 #2064로 no-op가 된 로컬 발사 채널을 계속 measure한 사건 — #2231에서 재정의).
 * wire-completion(연결) 룰은 있었지만 de-wire(은퇴) 룰이 없어 이 class가 반복됐다.
 *
 * 등재 규약: push/silent-push 계열(사건 발생 영역) 핵심 지표부터 등재한다 — 전체 지표 과설계 금지.
 * 새 지표 추가 시 `emitterSymbol`이 실제 신호를 만들어내는 함수/심볼 이름과 정확히 일치해야 한다.
 * `findDewiredSignals`(같은 디렉토리)가 비-테스트 코드에서 그 심볼의 참조(정의 외 호출 지점)가
 * 있는지 검증한다 — 참조가 없으면(정의만 있고 아무도 호출하지 않으면) CI가 fail한다.
 */
export interface SignalProvenanceEntry {
  /** 관측 지표 키 (DebugModal / observabilityMetricsClient 등에 노출되는 이름) */
  readonly metricKey: string;
  /** 그 지표가 실제로 tracking하는 emitter 함수/심볼 이름 */
  readonly emitterSymbol: string;
  /** emitter가 정의된 파일 경로 (repo root 기준, 문서 참고용) */
  readonly emitterFile: string;
  /** 등재 배경 설명 */
  readonly description: string;
}

export const SIGNAL_PROVENANCE_REGISTRY: readonly SignalProvenanceEntry[] = [
  {
    metricKey: 'silentPushReach(local)',
    emitterSymbol: 'logSilentPushReceived',
    emitterFile: 'src/features/alarm/utils/alarmLog.ts',
    description:
      '#2231 재정의 — visible station kind(station-passed/transfer/destination) silent push 수신을 ' +
      'silentPushTask.ts가 logSilentPushReceived로 alarmLog에 적재하고, ' +
      'computeSilentPushReach(alarmLog.ts)가 visibleReceived/totalReceived로 집계한다.',
  },
  {
    metricKey: 'silentPushReachRatio',
    emitterSymbol: 'stampSent',
    emitterFile: 'backend/alarm-worker/src/silentPushReachMetric.ts',
    description:
      'backend 5min corrId-join 도달률(#1958). pendingPushes.ts가 push 발사 시 stampSent로 ' +
      'sent stamp를 KV에 기록하고, computeSilentPushReachRatio가 received와 join해 ratio를 낸다.',
  },
] as const;
