/**
 * #2655 — leg-2 trainCode embed(#2820, 이미 머지)의 backend↔device wire 계약 fixture.
 *
 * 기존 replay/unit 커버리지는 한쪽만 검증했다:
 *   - backend `apns.test.ts` (#2819) — `sendBoardingPromptPush`가 trainCode를 wire에 싣는지만.
 *   - device `useBoardingPromptResponder.test.ts` (#2819) — 손으로 만든 mock payload를
 *     `extractBoardingPromptPayload`/`tryAutoLock`이 올바르게 소비하는지만.
 *
 * 두 벌 fixture가 각자 따로 손으로 유지되면 한쪽 필드명/위치가 바뀌어도(wire drift) 부품
 * 테스트는 green을 유지한다(부품 green≠whole). 이 모듈은 **단일 SSoT fixture**를 export해
 * backend 테스트(`backend/alarm-worker/src/__tests__/wire_20260928_boarding_prompt_traincode.test.ts`)
 * 가 "이 shape을 실제로 wire에 싣는지"를, device 테스트
 * (`src/features/alarm/__tests__/replay_20260928_leg2_traincode_wire.test.ts`)가 "이 shape을
 * 실제로 올바르게 소비하는지"를 각자 assert하게 해 경계를 넘는 계약으로 묶는다.
 *
 * 순수 데이터 모듈 — 런타임 동작 없음. backend `tsconfig.json`의 `include`에 이 파일 경로가
 * 명시돼 있어야 backend `tsc --noEmit`이 통과한다(#1624 CI Backend Validation job).
 */

/** `sendBoardingPromptPush`에 넘기는 trip 컨텍스트 필드 — trainCode 단일 확정 케이스. */
export const BOARDING_PROMPT_WIRE_FIXTURE = {
  pushId: 'wire-fx-2655-push-1',
  title: '탑승하셨나요?',
  body: '2호선 건대입구',
  originStation: '건대입구',
  line: '2',
  tripToken: 'wire-fx-2655-trip-1',
  sentAt: 1758999999000,
  trainCode: '2081',
} as const;

/**
 * `BOARDING_PROMPT_WIRE_FIXTURE`를 backend가 발사했을 때 APNs payload의 `body` 키(=device
 * `content.data`)에 실려야 하는 정확한 shape. backend/device 양쪽이 이 객체 하나를 기준으로
 * 검증한다.
 */
export const BOARDING_PROMPT_WIRE_DATA = {
  pushId: BOARDING_PROMPT_WIRE_FIXTURE.pushId,
  kind: 'boarding-prompt' as const,
  originStation: BOARDING_PROMPT_WIRE_FIXTURE.originStation,
  line: BOARDING_PROMPT_WIRE_FIXTURE.line,
  tripToken: BOARDING_PROMPT_WIRE_FIXTURE.tripToken,
  sentAt: BOARDING_PROMPT_WIRE_FIXTURE.sentAt,
  trainCode: BOARDING_PROMPT_WIRE_FIXTURE.trainCode,
} as const;

/** trainCode 미지정(ambiguity / 구버전 caller) 케이스 — 회귀 대비 짝. */
export const BOARDING_PROMPT_WIRE_FIXTURE_NO_TRAINCODE = {
  pushId: 'wire-fx-2655-push-2',
  title: '탑승하셨나요?',
  body: '2호선 건대입구',
  originStation: '건대입구',
  line: '2',
  tripToken: 'wire-fx-2655-trip-2',
  sentAt: 1758999999001,
} as const;

/** trainCode 필드 자체가 존재하지 않아야 하는 기대 shape. */
export const BOARDING_PROMPT_WIRE_DATA_NO_TRAINCODE = {
  pushId: BOARDING_PROMPT_WIRE_FIXTURE_NO_TRAINCODE.pushId,
  kind: 'boarding-prompt' as const,
  originStation: BOARDING_PROMPT_WIRE_FIXTURE_NO_TRAINCODE.originStation,
  line: BOARDING_PROMPT_WIRE_FIXTURE_NO_TRAINCODE.line,
  tripToken: BOARDING_PROMPT_WIRE_FIXTURE_NO_TRAINCODE.tripToken,
  sentAt: BOARDING_PROMPT_WIRE_FIXTURE_NO_TRAINCODE.sentAt,
} as const;
