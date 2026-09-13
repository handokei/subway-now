/**
 * replay fixture CLI 스크립트 공용 유틸(#2586 코드리뷰) — `buildReplayFixture.mjs`(#2580)와
 * `fixtureFromTrip.mjs`(#2586)가 verbatim 중복해 갖고 있던 인자 파싱 + capture cycle 파일
 * 읽기 로직을 여기로 수렴한다. 둘 다 얇은 I/O 셸이라 이 유틸도 I/O만 하고 검증 로직은
 * 갖지 않는다 — `parseCycle`(주로 `parseSeoulCaptureCycle`, `../src/replayFixture.ts`)을
 * 호출자가 주입한다.
 */
import { readFileSync } from 'node:fs';

/**
 * `--key value` 형태 CLI 인자를 object로 파싱한다. `booleanFlags`에 나열된 키(예: `force`)는
 * bare flag로 취급해 다음 토큰을 값으로 소비하지 않고 `true`만 설정한다 — 소비하면
 * `--force`가 그 뒤의 다른 `--key value` 토큰을 값으로 삼켜버리거나(예:
 * `--force --token-hash x` → `force: '--token-hash'`, `token-hash` 인자 자체가 유실),
 * 맨 끝에 오면 `argv[i+1]`이 `undefined`가 되어 `!== undefined` 체크가 깨진다(#2586
 * 코드리뷰 — 재현 확인된 버그).
 */
export function parseArgs(argv, booleanFlags = []) {
  const booleanFlagSet = new Set(booleanFlags);
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    const flagName = key.slice(2);
    if (booleanFlagSet.has(flagName)) {
      args[flagName] = true;
      continue;
    }
    args[flagName] = argv[i + 1];
    i += 1;
  }
  return args;
}

/**
 * cycle 파일 하나를 읽어 `parseCycle`로 검증한다. JSON 파싱/스키마 검증 실패를 각각
 * `{ error }`로 반환한다(throw하지 않음 — 호출자가 파일 단위로 skip 여부를 결정).
 */
export function readCycleFile(filePath, parseCycle) {
  let parsedJson;
  try {
    parsedJson = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch (err) {
    return { error: `JSON 파싱 실패: ${err instanceof Error ? err.message : String(err)}` };
  }
  try {
    return { cycle: parseCycle(parsedJson) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
