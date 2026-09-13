/**
 * replay fixture CLI 스크립트 공용 유틸(#2586 코드리뷰) — `buildReplayFixture.mjs`(#2580)와
 * `fixtureFromTrip.mjs`(#2586)가 verbatim 중복해 갖고 있던 인자 파싱 + capture cycle 파일
 * 읽기 로직을 여기로 수렴한다. 둘 다 얇은 I/O 셸이라 이 유틸도 I/O만 하고 검증 로직은
 * 갖지 않는다 — `parseCycle`(주로 `parseSeoulCaptureCycle`, `../src/replayFixture.ts`)을
 * 호출자가 주입한다.
 */
import { readFileSync } from 'node:fs';

/** `--key value` 형태 CLI 인자를 object로 파싱한다. */
export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    args[key.slice(2)] = argv[i + 1];
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
