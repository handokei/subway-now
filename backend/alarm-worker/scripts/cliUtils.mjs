/**
 * replay fixture CLI 스크립트 공용 유틸(#2586 코드리뷰) — `buildReplayFixture.mjs`(#2580)와
 * `fixtureFromTrip.mjs`(#2586)가 verbatim 중복해 갖고 있던 인자 파싱 + capture cycle 파일
 * 읽기 로직을 여기로 수렴한다. 둘 다 얇은 I/O 셸이라 이 유틸도 I/O만 하고 검증 로직은
 * 갖지 않는다 — `parseCycle`(주로 `parseSeoulCaptureCycle`, `../src/replayFixture.ts`)을
 * 호출자가 주입한다.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

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

/**
 * wrangler CLI 실행 지점 해석(#2598) — 글로벌 wrangler가 PATH에 없는 환경(repo 표준=npx
 * 사용)에서 bare `wrangler` spawn이 ENOENT로 즉사하는 문제 수리. `scriptDir/../node_modules/
 * .bin/wrangler`(devDependency 로컬 설치, `backend/alarm-worker/scripts/`의 부모 =
 * `backend/alarm-worker/`)가 존재하면 그것을 직접 실행하고, 없으면 `npx --no-install
 * wrangler`로 fallback한다 — 어느 쪽이든 PATH에 wrangler가 없어도 동작한다.
 *
 * `--no-install`(#2598 리뷰): plain `npx wrangler`는 로컬에 없으면 npm registry에서
 * unpinned 최신 버전을 몰래 내려받거나(devDependency `^4.105.0`과 버전 drift 위험)
 * interactive 설치 확인 프롬프트를 띄운다(비대화형 CLI 실행 흐름을 멈춤). `--no-install`은
 * 그 대신 즉시 실패한다 — 호출자(`fixtureFromTrip.mjs`)가 그 실패를 감지해 "npm install
 * 필요"로 명확히 안내한다.
 *
 * 반환값 `{ cmd, prefixArgs }`를 `execFileSync(cmd, [...prefixArgs, ...args])`에 그대로
 * 펼쳐 쓴다. `buildReplayFixture.mjs`는 현재 wrangler를 호출하지 않지만(로컬 캡처 디렉토리만
 * 읽음), 향후 wrangler 호출이 필요해지면 이 헬퍼를 그대로 재사용한다.
 */
export function resolveWranglerCommand(scriptDir) {
  const binName = process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler';
  const localBinPath = path.join(scriptDir, '..', 'node_modules', '.bin', binName);
  if (existsSync(localBinPath)) {
    return { cmd: localBinPath, prefixArgs: [] };
  }
  return { cmd: 'npx', prefixArgs: ['--no-install', 'wrangler'] };
}

/**
 * `npx --no-install`이 wrangler를 찾지 못했을 때(devDependency 미설치) 뱉는 특징적인 에러
 * 문구를 감지한다(#2598 리뷰로 fixtureFromTrip.mjs에 있던 것을 #2600에서 이곳으로 이전 —
 * `runCli`가 공용화되며 같이 옮겨야 동일 안내 메시지를 유지할 수 있다).
 */
function isNpxMissingWranglerError(err) {
  const stderrText = err && err.stderr ? String(err.stderr) : '';
  const messageText = err instanceof Error ? err.message : String(err);
  return /could not determine executable to run/i.test(`${stderrText} ${messageText}`);
}

/**
 * wrangler CLI 실행 지점을 한 곳으로 수렴(#2598) — 로컬 devDependency bin이 있으면 그것을,
 * 없으면 `npx --no-install wrangler`로 실행한다. `fixtureFromTrip.mjs` 전용이던 것을 #2600에서
 * 이곳으로 옮겨 wrangler를 호출하는 스크립트가 늘어나도 재사용한다.
 *
 * `cwd` 옵션(#2600) — 지정하지 않으면 Node 기본값(현재 process.cwd())을 그대로 쓴다. wrangler는
 * `wrangler.toml`을 자신의 cwd 기준으로 찾으므로, repo 루트 등 다른 위치에서 이 스크립트를
 * 실행해도 정상 동작하려면 호출자가 `backend/alarm-worker` 절대경로를 `cwd`로 명시해야 한다
 * (재현: 지정 없이 repo 루트에서 실행 시 `wrangler d1 execute`가 wrangler.toml을 못 찾아 실패).
 *
 * win32에서는 `.cmd` 셔블(예: npx.cmd/wrangler.cmd)을 `shell` 옵션 없이 `execFileSync`로
 * 직접 실행하면 EINVAL로 즉사한다(Node 2024-04 CVE-2024-27980가 명시한 Windows 배치 파일
 * spawn 제약) — win32에서만 `shell: true`를 강제한다.
 */
export function runCli(scriptDir, args, options = {}) {
  const { cmd, prefixArgs } = resolveWranglerCommand(scriptDir);
  const platformOptions = process.platform === 'win32' ? { shell: true } : {};
  try {
    // NOSONAR — dev-only local CLI; wrangler resolution + win32 shell 강제는 의도된 동작(S4036)
    return execFileSync(cmd, [...prefixArgs, ...args], { encoding: 'utf-8', ...options, ...platformOptions });
  } catch (err) {
    if (cmd === 'npx' && isNpxMissingWranglerError(err)) {
      throw new Error(
        'wrangler를 찾을 수 없습니다 — backend/alarm-worker에서 npm install 필요(devDependency 미설치, PATH에도 wrangler 없음).',
      );
    }
    throw err;
  }
}
