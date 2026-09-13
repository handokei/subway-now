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
 *   trip 시나리오의 "매역 발사 결론"을 다시 주장하지 않는다(이중 유지보수 방지).
 *
 * fixture는 각 entry의 `loadFixture()`(메모이즈, `it()` 본문에서만 호출)로 얻는다 — describe
 * 본문(collection 시점)에서 파싱하면 malformed fixture 하나가 라이브러리 전체 collection을
 * 죽인다. `entry.loadFixture`가 그 격리를 책임진다(#2585 리뷰).
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PHASE_OFFSETS_MS, REPLAY_LIBRARY, REPLAY_LIBRARY_DIR, type ReplayLibraryEntry } from './replayLibrary';
import { isLossyFixture } from '../replayFixture';
import { runCaptureReplay, type CapturedPush } from './helpers/replayHarness';

const FIXTURE_SUFFIX = '.fixture.json';

function listFixtureFilesOnDisk(): string[] {
  return fs.readdirSync(REPLAY_LIBRARY_DIR).filter((name) => name.endsWith(FIXTURE_SUFFIX));
}

/** alert push 중 nextWaypoint를 실은 것 전부 — 시간순, **중복 제거하지 않는다**. 같은 역이
 * 두 번 발사되면(회귀) 그 중복이 그대로 남아야 sorted exact-match가 이를 잡아낸다. */
function firedStationOccurrences(pushes: CapturedPush[]): string[] {
  const occurrences: string[] = [];
  for (const push of pushes) {
    if (push.headers.pushType !== 'alert') continue;
    const data = push.body.data as Record<string, unknown> | undefined;
    const station = data?.nextWaypoint;
    if (typeof station === 'string' && station.length > 0) occurrences.push(station);
  }
  return occurrences;
}

function tripEndedFired(pushes: CapturedPush[], reason: string): boolean {
  return pushes.some((push) => {
    if (push.headers.pushType !== 'alert') return false;
    const data = push.body.data as Record<string, unknown> | undefined;
    return data?.kind === 'trip-ended' && data?.reason === reason;
  });
}

function resolveCronIntervalMs(cronIntervalMs: ReplayLibraryEntry['cronIntervalMs']): number | undefined {
  return cronIntervalMs === 'recorded' ? undefined : cronIntervalMs;
}

describe('replay library — 디렉터리 ↔ registry 1:1 대조', () => {
  it('디렉터리의 모든 *.fixture.json이 REPLAY_LIBRARY에 등록돼 있다', () => {
    const onDisk = listFixtureFilesOnDisk();
    const registered = REPLAY_LIBRARY.map((entry) => entry.fixturePath);
    expect(onDisk.sort()).toEqual(registered.sort());
  });

  it('각 entry의 slug는 fixturePath의 basename(.fixture.json 제외)과 일치한다', () => {
    for (const entry of REPLAY_LIBRARY) {
      expect(entry.slug).toBe(path.basename(entry.fixturePath, FIXTURE_SUFFIX));
    }
  });

  it('REPLAY_LIBRARY entry가 최소 1개 이상이다 (조용한 0-test 통과 방지)', () => {
    expect(REPLAY_LIBRARY.length).toBeGreaterThan(0);
  });
});

for (const entry of REPLAY_LIBRARY) {
  describe(`replay library — ${entry.slug}`, () => {
    it('lossy 캡처(droppedEntries/failedCycleStartsMs)는 명시 allowLossy:true 없이 라이브러리에 들어올 수 없다', () => {
      const fixture = entry.loadFixture();
      if (isLossyFixture(fixture)) {
        expect(entry.allowLossy).toBe(true);
      }
    });

    it('allowLossy:true는 fixture에 실제 lossy 신호가 있을 때만 유효하다 (stale 플래그 방지)', () => {
      const fixture = entry.loadFixture();
      const staleAllowLossy = Boolean(entry.allowLossy) && !isLossyFixture(fixture);
      expect(staleAllowLossy).toBe(false);
    });

    const phaseOffsets = entry.phaseOffsetsMs ?? DEFAULT_PHASE_OFFSETS_MS;

    for (const phaseOffsetMs of phaseOffsets) {
      it(`위상 offset=${phaseOffsetMs}ms — 기대 발사/차단/완결 충족`, async () => {
        const fixture = entry.loadFixture();
        const result = await runCaptureReplay({
          fixture,
          seedTrips: entry.seedTrips(),
          cronIntervalMs: resolveCronIntervalMs(entry.cronIntervalMs),
          phaseOffsetMs,
          apns: 'capture',
        });

        const fired = firedStationOccurrences(result.pushes);

        // 순서 무시, 정렬 후 exact-match — 역 하나 누락/추가되면 실패하고(수락 기준: registry
        // expect에서 역 하나 제거 시 red), 위상별로 인접 tick 사이에서 발사 순서가 뒤바뀌는
        // 것(회귀 아님)은 false-red를 만들지 않는다. 중복 제거를 하지 않은 채로 비교하므로
        // 같은 역이 두 번 발사되면(회귀) sorted 배열 길이가 달라져 그 자체로 실패한다.
        expect([...fired].sort()).toEqual([...entry.expect.firedStations].sort());

        for (const forbidden of entry.expect.forbiddenStations ?? []) {
          expect(fired).not.toContain(forbidden);
        }

        if (entry.expect.minPushes !== undefined) {
          expect(result.pushes.length).toBeGreaterThanOrEqual(entry.expect.minPushes);
        }

        if (entry.expect.tripEnded) {
          expect(tripEndedFired(result.pushes, entry.expect.tripEnded.reason)).toBe(true);
        }
      });
    }
  });
}
