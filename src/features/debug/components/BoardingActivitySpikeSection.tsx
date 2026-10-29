/**
 * #3221 PR-1 — 탑승 LA 실기기 스파이크(§10-1) 섹션.
 *
 * DebugModal(release는 EXPO_PUBLIC_DEBUG_MODAL=true일 때만 노출) 안에서 탑승 LA를 FG로 시작/종료하고
 * 기기 단위 push-to-start token 발급을 확인한다. 프로덕션 경로(알람/여정 LA)는 건드리지 않는다.
 */
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  addBoardingActivityEndedListener,
  addBoardingPushToStartTokenListener,
  endBoardingActivities,
  requestBoardingPushToStartToken,
  startBoardingActivity,
} from 'live-activity';
import { spacing, radius, typography, useTheme } from '../../../shared/theme';

const NOT_ISSUED = '미발급 (17.2 미만이거나 아직 발급 전)';

/** 스파이크 전용 샘플 — 시안(Boarding.dc.html)의 7호선 용마산 질문. */
function buildSampleBoardingActivity() {
  return {
    promptId: `debug-${Date.now()}`,
    tripToken: 'debug-trip',
    phase: 'pre-boarding' as const,
    originStation: '용마산',
    line: '7호선',
    lineName: '7호선',
    lineColorHex: '#747F00',
    trainInfo: '용마산 · 건대입구 방면 7035 열차',
    title: '탑승하셨나요?',
  };
}

export function BoardingActivitySpikeSection() {
  const { colors } = useTheme();
  const [token, setToken] = useState<string | null>(null);
  const [status, setStatus] = useState('대기');

  useEffect(() => {
    let alive = true;
    requestBoardingPushToStartToken().then((hex) => {
      if (alive && hex) setToken(hex);
    });
    const tokenSub = addBoardingPushToStartTokenListener((e) => setToken(e.token));
    const endedSub = addBoardingActivityEndedListener((e) =>
      setStatus(`종료 이벤트: ${e.state} (${e.promptId})`),
    );
    return () => {
      alive = false;
      tokenSub.remove();
      endedSub.remove();
    };
  }, []);

  const handleStart = async () => {
    try {
      await startBoardingActivity(buildSampleBoardingActivity());
      setStatus('시작 요청 완료');
    } catch (e) {
      setStatus(`시작 실패: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handleEnd = async () => {
    await endBoardingActivities();
    setStatus('종료 요청 완료');
  };

  return (
    <View style={[styles.section, { backgroundColor: colors.card }]} testID="debug-boarding-la-section">
      <Text style={[typography.label, { color: colors.muted, marginBottom: spacing.sm }]}>
        SPIKE — 탑승 LA (#3221)
      </Text>
      <Text
        style={[typography.mono, { color: colors.ink, marginBottom: spacing.sm }]}
        selectable
        testID="debug-boarding-la-token"
      >
        {`push-to-start token: ${token ?? NOT_ISSUED}`}
      </Text>
      <Text
        style={[typography.mono, { color: colors.ink, marginBottom: spacing.sm }]}
        testID="debug-boarding-la-status"
      >
        {`상태: ${status}`}
      </Text>
      <View style={styles.row}>
        <Pressable
          onPress={handleStart}
          style={[styles.actionButton, { backgroundColor: colors.accent }]}
          testID="debug-boarding-la-start"
        >
          <Text style={[typography.bodySm, { color: colors.onAccent }]}>탑승 LA 테스트 시작</Text>
        </Pressable>
        <Pressable
          onPress={handleEnd}
          style={[styles.actionButton, { backgroundColor: colors.warn }]}
          testID="debug-boarding-la-end"
        >
          <Text style={[typography.bodySm, { color: colors.onAccent }]}>탑승 LA 테스트 종료</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    padding: spacing.lg,
    borderRadius: radius.md,
    marginBottom: spacing.md,
  },
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  actionButton: {
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
});
