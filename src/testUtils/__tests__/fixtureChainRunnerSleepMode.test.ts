/**
 * #2068 — mode-aware chain stage 검증: `general-mode-no-alarm-sound` /
 * `sleep-mode-no-per-station-notification`.
 *
 * Epic #2061 확정 스펙(본문 표):
 *   - 일반 모드(sleepMode=off): 알람류(transfer/destination, alarm.wav) 발사 0건이어야 한다.
 *   - 취침 모드(sleepMode=on): 매역 notification(station-passed) 발사 0건이어야 한다.
 *
 * 현재 프로덕션 코드(Phase 1 #2063/#2064, Phase 2 #2066/#2067 미완)는 이 정책을 구현하지
 * 않았다 — `sendAlarmNotification`(stationNotification.ts:591)의 sound는 sleepMode와
 * 무관하게 allowSpeaker로만 결정된다. 따라서 `general-mode-no-alarm-sound` stage는 회귀
 * fixture(regression-general-mode-alarm-sound.txt, sleepMode=off + transfer 알람 fired)에서
 * red로 재현되며, `it.failing`으로 마킹한다. Phase 1·2 완료 후 해당 PR에서 unskip한다.
 *
 * `sleep-mode-no-per-station-notification`은 sleepMode=on fixture가 현재 저장소에 없어
 * (모든 day2/phase61 fixture가 sleepMode=off) 오탐 없이 green — 회귀 fixture는 향후
 * Phase 2 device verify에서 실기기 dump로 보강 예정.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDumpFixture } from '../dumpParser';
import { runChainFromDump } from '../fixtureChainRunner';

const DAY2_DIR = join(__dirname, '../fixtures/day2');

function loadAndRun(filename: string) {
  const text = readFileSync(join(DAY2_DIR, filename), 'utf-8');
  return runChainFromDump(parseDumpFixture(text));
}

describe('general-mode-no-alarm-sound', () => {
  // #2068 회귀 재현 — 현재 코드는 일반 모드에서도 alarm.wav(transfer/destination)를 발사한다.
  // Phase 1·2 완료 전까지 fail이 정상. unskip 조건: #2063/#2064/#2066/#2067 전부 머지.
  it.failing(
    '일반 모드(sleepMode=off) + transfer 알람 fired → stage fail (Phase 1·2 완료 전 red)',
    () => {
      const report = loadAndRun('regression-general-mode-alarm-sound.txt');
      const stage = report.stages.find((s) => s.stage === 'general-mode-no-alarm-sound');
      expect(stage?.passed).toBe(true);
    },
  );

  it('evidence에 sleepMode와 alarmKinds가 표시된다', () => {
    const report = loadAndRun('regression-general-mode-alarm-sound.txt');
    const stage = report.stages.find((s) => s.stage === 'general-mode-no-alarm-sound');
    expect(stage?.evidence).toContain('sleepMode=off');
    expect(stage?.evidence).toContain('transfer');
  });

  it('정상 trip(morning-trip.txt)도 transfer 알람이 fired라 현재는 동일하게 fail (회귀 범위 확인)', () => {
    const report = loadAndRun('morning-trip.txt');
    const stage = report.stages.find((s) => s.stage === 'general-mode-no-alarm-sound');
    expect(stage?.passed).toBe(false);
  });

  it('sleepMode 신호 부재 fixture는 판정 보류(pass) — 오탐 방지', () => {
    const report = runChainFromDump({
      capturedAt: undefined,
      tripStartedAt: undefined,
      lifecyclePhase: undefined,
      fusionConfidence: undefined,
      subsurface: undefined,
      gpsAccuracy: undefined,
      environment: undefined,
      silentPushReceived: undefined,
      silentPushFired: undefined,
      boardingLockActive: undefined,
      sleepMode: undefined,
      alarmLogSources: {},
      notificationsFiredCount: undefined,
      notificationKinds: ['transfer'],
      coldStart: undefined,
    });
    const stage = report.stages.find((s) => s.stage === 'general-mode-no-alarm-sound');
    expect(stage?.passed).toBe(true);
  });

  it('sleepMode=off + alarm kind 없음 → pass', () => {
    const report = runChainFromDump({
      capturedAt: undefined,
      tripStartedAt: undefined,
      lifecyclePhase: undefined,
      fusionConfidence: undefined,
      subsurface: undefined,
      gpsAccuracy: undefined,
      environment: undefined,
      silentPushReceived: undefined,
      silentPushFired: undefined,
      boardingLockActive: undefined,
      sleepMode: 'off',
      alarmLogSources: {},
      notificationsFiredCount: undefined,
      notificationKinds: ['station-passed'],
      coldStart: undefined,
    });
    const stage = report.stages.find((s) => s.stage === 'general-mode-no-alarm-sound');
    expect(stage?.passed).toBe(true);
  });
});

describe('sleep-mode-no-per-station-notification', () => {
  it('sleepMode=on + station-passed fired → fail', () => {
    const report = runChainFromDump({
      capturedAt: undefined,
      tripStartedAt: undefined,
      lifecyclePhase: undefined,
      fusionConfidence: undefined,
      subsurface: undefined,
      gpsAccuracy: undefined,
      environment: undefined,
      silentPushReceived: undefined,
      silentPushFired: undefined,
      boardingLockActive: undefined,
      sleepMode: 'on',
      alarmLogSources: {},
      notificationsFiredCount: undefined,
      notificationKinds: ['station-passed'],
      coldStart: undefined,
    });
    const stage = report.stages.find((s) => s.stage === 'sleep-mode-no-per-station-notification');
    expect(stage?.passed).toBe(false);
    expect(stage?.evidence).toContain('sleepMode=on');
    expect(stage?.evidence).toContain('station-passed-fired=true');
  });

  it('sleepMode=on + station-passed 없음 → pass', () => {
    const report = runChainFromDump({
      capturedAt: undefined,
      tripStartedAt: undefined,
      lifecyclePhase: undefined,
      fusionConfidence: undefined,
      subsurface: undefined,
      gpsAccuracy: undefined,
      environment: undefined,
      silentPushReceived: undefined,
      silentPushFired: undefined,
      boardingLockActive: undefined,
      sleepMode: 'on',
      alarmLogSources: {},
      notificationsFiredCount: undefined,
      notificationKinds: ['transfer'],
      coldStart: undefined,
    });
    const stage = report.stages.find((s) => s.stage === 'sleep-mode-no-per-station-notification');
    expect(stage?.passed).toBe(true);
  });

  it('일반 모드(sleepMode=off) fixture는 항상 pass (stage 무관 통과)', () => {
    const report = loadAndRun('morning-trip.txt');
    const stage = report.stages.find((s) => s.stage === 'sleep-mode-no-per-station-notification');
    expect(stage?.passed).toBe(true);
  });

  it('sleepMode 신호 부재 → 판정 보류(pass)', () => {
    const report = runChainFromDump({
      capturedAt: undefined,
      tripStartedAt: undefined,
      lifecyclePhase: undefined,
      fusionConfidence: undefined,
      subsurface: undefined,
      gpsAccuracy: undefined,
      environment: undefined,
      silentPushReceived: undefined,
      silentPushFired: undefined,
      boardingLockActive: undefined,
      sleepMode: undefined,
      alarmLogSources: {},
      notificationsFiredCount: undefined,
      notificationKinds: ['station-passed'],
      coldStart: undefined,
    });
    const stage = report.stages.find((s) => s.stage === 'sleep-mode-no-per-station-notification');
    expect(stage?.passed).toBe(true);
  });
});
