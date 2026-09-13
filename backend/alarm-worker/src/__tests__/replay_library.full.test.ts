/**
 * 재생 fixture 라이브러리 전량 재생 게이트 (Epic #2239 P2, #2585).
 *
 * `REPLAY_LIBRARY`(replayLibrary.ts, 데이터 주도 SSoT) 순회 × 각 entry의 `phaseOffsetsMs`
 * 순회 → `runCaptureReplay` → `expect` 검증. `Backend Validation` CI job이 backend vitest
 * 전체를 돌리므로(#1624) 이 파일이 존재하는 것 자체가 PR 게이트다 — 신규 workflow/job 불필요.
 *
 * 책임 경계 (`replay_harness_line7.test.ts`와 분리, #2585 PR 본문 참고):
 * - 이 파일: registry 데이터 기반 "전 시나리오 × 전 위상 회귀 없음" 게이트.
 * - `replay_harness_line7.test.ts`: 하네스 자체의 기계적 정확성 단위 검증(freshness 경계,
 *   truncated/status=0 매핑, cron drift, KV TTL 벽시계 독립성, trainCode 파싱 관통) — 특정
 *   trip 시나리오의 "매역 발사 결론"을 다시 주장하지 않는다(이중 유지보수 방지, 이 이슈
 *   구현 시 해당 파일에서 라이브러리와 중복되던 결론 assertion을 제거했다).
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPLAY_LIBRARY } from './replayLibrary';
import { parseReplayFixture } from '../replayFixture';
import { runCaptureReplay, type CapturedPush } from './helpers/replayHarness';

const REPLAY_LIBRARY_DIR = path.join(__dirname, 'fixtures', 'replayLibrary');
const FIXTURE_SUFFIX = '.fixture.json';

function listFixtureFilesOnDisk(): string[] {
  return fs.readdirSync(REPLAY_LIBRARY_DIR).filter((name) => name.endsWith(FIXTURE_SUFFIX));
}

/** alert push 중 nextWaypoint를 실은 것만 "매역 발사"로 집계 — 최초 등장 순서 보존, 중복 제거. */
function orderedFiredStations(pushes: CapturedPush[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const push of pushes) {
    if (push.headers.pushType !== 'alert') continue;
    const data = push.body.data as Record<string, unknown> | undefined;
    const station = data?.nextWaypoint;
    if (typeof station === 'string' && station.length > 0 && !seen.has(station)) {
      seen.add(station);
      ordered.push(station);
    }
  }
  return ordered;
}

describe('replay library — 디렉터리 ↔ registry 1:1 대조', () => {
  it('디렉터리의 모든 *.fixture.json이 REPLAY_LIBRARY에 등록돼 있다', () => {
    const onDisk = listFixtureFilesOnDisk();
    const registered = REPLAY_LIBRARY.map((entry) => entry.fixturePath);
    expect(onDisk.sort()).toEqual(registered.sort());
  });

  it('REPLAY_LIBRARY entry가 최소 1개 이상이다 (조용한 0-test 통과 방지)', () => {
    expect(REPLAY_LIBRARY.length).toBeGreaterThan(0);
  });
});

for (const entry of REPLAY_LIBRARY) {
  describe(`replay library — ${entry.slug}`, () => {
    const fixturePath = path.join(REPLAY_LIBRARY_DIR, entry.fixturePath);
    const fixture = parseReplayFixture(JSON.parse(fs.readFileSync(fixturePath, 'utf8')));

    if ((fixture.droppedEntries ?? 0) > 0 || (fixture.failedCycleStartsMs?.length ?? 0) > 0) {
      it('lossy 캡처는 명시 allowLossy:true 없이 라이브러리에 들어올 수 없다', () => {
        expect(entry.allowLossy).toBe(true);
      });
    } else if (entry.allowLossy) {
      it('allowLossy:true인데 fixture에 실제 lossy 신호가 없다 — 플래그가 무의미해졌는지 확인', () => {
        // fixture가 나중에 정제돼 lossy 신호가 사라졌다면 플래그도 같이 제거해야 한다는 신호.
        const isLossy = (fixture.droppedEntries ?? 0) > 0 || (fixture.failedCycleStartsMs?.length ?? 0) > 0;
        expect(isLossy).toBe(false);
      });
    }

    for (const phaseOffsetMs of entry.phaseOffsetsMs) {
      it(`위상 offset=${phaseOffsetMs}ms — 기대 발사/차단 충족`, async () => {
        const result = await runCaptureReplay({
          fixture,
          seedTrips: entry.seedTrips(),
          cronIntervalMs: entry.cronIntervalMs,
          phaseOffsetMs,
          apns: 'capture',
        });

        const fired = orderedFiredStations(result.pushes);

        // 정확히 일치 — 하나라도 누락/추가/순서 어긋나면 실패한다(수락 기준: registry
        // expect에서 역 하나 제거 시 red 재현). forbiddenStations는 이 exact match와
        // 별개로, 향후 firedStations를 완전 열거하지 않는 entry가 추가될 때를 대비한 별도
        // 명시적 오발사 가드다.
        expect(fired).toEqual(entry.expect.firedStations);

        for (const forbidden of entry.expect.forbiddenStations ?? []) {
          expect(fired).not.toContain(forbidden);
        }

        if (entry.expect.minPushes !== undefined) {
          expect(result.pushes.length).toBeGreaterThanOrEqual(entry.expect.minPushes);
        }
      });
    }
  });
}
