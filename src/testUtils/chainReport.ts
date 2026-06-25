/**
 * #1833 — fixture chain simulation 인프라: ChainReport 데이터 모델 + CHAIN_STAGES SSOT.
 *
 * chain stage는 "사용자 가치 흐름" 순서로 정의된다. 새 stage 추가 시 이 배열 한 곳만 수정하면
 * runChainFromDump + chain assertion DSL 양쪽이 자동 확장된다 (data-driven).
 *
 * Day 2 evidence: received=0, environment=unknown, boardingPrompt=blocked.
 * 각 stage의 passed 판정 기준은 dumpParser.ts에서 파싱한 DumpFixture 필드를 기반으로
 * fixtureChainRunner.ts가 산출한다.
 */

/**
 * chain stage 식별자. 값의 순서 = 가치 흐름 순서.
 * stage를 추가하거나 이름을 바꿀 때는 fixtureChainRunner.ts의 STAGE_CHECKERS도 갱신한다.
 */
export const CHAIN_STAGE_IDS = [
  'trip-registered',
  'environment-classified',
  'boardingPrompt-displayed',
  'lock-attach',
  'silent-push-received',
  'station-passed-fired',
] as const;

export type ChainStageId = (typeof CHAIN_STAGE_IDS)[number];

/**
 * 단일 chain stage 평가 결과.
 *
 * @field stage    - stage 식별자
 * @field passed   - true면 이 stage는 조건 충족
 * @field evidence - 파싱된 원시 값 ("received=6", "active=yes" 등). 실패 디버깅용.
 */
export interface ChainStageResult {
  stage: ChainStageId;
  passed: boolean;
  evidence: string;
}

/**
 * runChainFromDump 반환 타입. 전체 chain 통과 여부 + 첫 stuck stage.
 *
 * @field stages      - CHAIN_STAGE_IDS 순서대로 평가된 결과 배열
 * @field firstStuck  - 첫 번째 passed=false stage. null이면 전체 pass.
 * @field allPassed   - 모든 stage pass 여부
 */
export interface ChainReport {
  stages: ChainStageResult[];
  firstStuck: ChainStageId | null;
  allPassed: boolean;
}

/** ChainReport 생성 헬퍼. stages 배열로부터 firstStuck, allPassed를 자동 산출. */
export function buildChainReport(stages: ChainStageResult[]): ChainReport {
  const firstStuck = stages.find((s) => !s.passed)?.stage ?? null;
  return {
    stages,
    firstStuck,
    allPassed: firstStuck === null,
  };
}
