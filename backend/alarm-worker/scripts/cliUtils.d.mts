/**
 * `cliUtils.mjs`(plain JS, `allowJs` 미설정 — Cloudflare Worker 프로덕션 코드에 JS 파일이
 * 섞이는 것을 막기 위해 backend tsconfig는 의도적으로 allowJs를 켜지 않는다)를 vitest에서
 * 타입 검사와 함께 import하기 위한 sibling 선언 파일. 런타임은 `cliUtils.mjs`가 그대로
 * 담당하고, 이 파일은 tsc/에디터에게 타입만 알려준다.
 */
export function parseArgs(argv: string[], booleanFlags?: string[]): Record<string, string | boolean | undefined>;

export function readCycleFile<T>(
  filePath: string,
  parseCycle: (json: unknown) => T,
): { cycle: T } | { error: string };

export function resolveWranglerCommand(scriptDir: string): { cmd: string; prefixArgs: string[] };

export function runCli(
  scriptDir: string,
  args: string[],
  options?: Record<string, unknown>,
): string;
