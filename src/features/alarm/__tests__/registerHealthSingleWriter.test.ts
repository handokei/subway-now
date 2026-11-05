/**
 * #3006 PR-2 (C11) — `useRegisterHealthStore`의 단일 writer 정적 가드.
 *
 * degraded 신호는 "POST /trips 결과"와 "목적지 변경"에서만 바뀐다(spec §2-4). 다른 곳이 몰래
 * 쓰기 시작하면 배너가 /trips와 무관한 이유로 켜지고 꺼진다 — 쓰기 지점 2곳을 이 테스트가 고정한다.
 * (`sentinelProducerNotices.test.ts`와 같은 패턴: 소스 전수 스캔, 주석 줄 제외)
 */
import * as fs from 'fs';
import * as path from 'path';

const SRC_ROOT = path.resolve(__dirname, '../../..');
const STORE_FILE = 'features/alarm/store/useRegisterHealthStore.ts';
const WRITER_FILE = 'features/alarm/hooks/useApnsTripRegistration.ts';
/** 쓰기 API 호출 표식 — hook의 쓰기 지점 2곳(503 결과 처리 / 목적지 변경 effect). */
const APPLY_CALL = 'applyRegisterHealthOutcome(';
const RESET_CALL = 'resetRegisterHealth(';
/** 스토어 직접 변경(우회 경로) 표식. */
const DIRECT_WRITE =
  /useRegisterHealthStore\s*\.\s*setState|useRegisterHealthStore\s*\.\s*getState\(\)\s*\.\s*\w+\s*\(/;

function listSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      listSourceFiles(full, out);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function codeLines(source: string): string[] {
  return source.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));
}

function count(source: string, needle: string): number {
  return codeLines(source).filter((line) => line.includes(needle)).length;
}

describe('useRegisterHealthStore 단일 writer (C11)', () => {
  const files = listSourceFiles(SRC_ROOT).map((file) => ({
    rel: path.relative(SRC_ROOT, file).split(path.sep).join('/'),
    source: fs.readFileSync(file, 'utf8'),
  }));
  const outsideStore = files.filter(({ rel }) => rel !== STORE_FILE);

  it('apply/reset 호출은 useApnsTripRegistration.ts 한 파일에만 있고 각각 정확히 1곳이다', () => {
    const appliers = outsideStore.filter(({ source }) => count(source, APPLY_CALL) > 0);
    const resetters = outsideStore.filter(({ source }) => count(source, RESET_CALL) > 0);
    expect(appliers.map(({ rel }) => rel)).toEqual([WRITER_FILE]);
    expect(resetters.map(({ rel }) => rel)).toEqual([WRITER_FILE]);
    const writer = files.find(({ rel }) => rel === WRITER_FILE);
    expect(count(writer?.source ?? '', APPLY_CALL)).toBe(1);
    expect(count(writer?.source ?? '', RESET_CALL)).toBe(1);
  });

  it('스토어 밖에서 setState/getState().<action>으로 우회 쓰기하는 코드가 없다', () => {
    const offenders = outsideStore
      .filter(({ source }) => codeLines(source).some((line) => DIRECT_WRITE.test(line)))
      .map(({ rel }) => rel);
    expect(offenders).toEqual([]);
  });
});
