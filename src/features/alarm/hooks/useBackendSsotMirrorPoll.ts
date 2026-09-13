/**
 * #2590 (SonarCloud `new_duplicated_lines_density` 해소) — backend SSoT mirror 5s 폴링 공통 훅.
 *
 * `useFusedNearestStation`(cascade picker)과 `useTransferTrainList`가 각자 구현하던 폴링
 * boilerplate(useState + useEffect + setInterval(5s) + cancelled 가드 + dedup reducer)가
 * 26~30줄 단위로 완전히 동일해 PR #2606에서 duplicated_lines_density 10%(threshold 3%)로
 * QG fail — 단일 훅으로 추출해 두 소비처가 공유한다.
 *
 * `backendSsotMirror.ts`(schema 소유 모듈) 내부가 아니라 이 별도 파일에 둔 이유: 그 모듈 안에
 * 정의하면 `readBackendSsotMirror`를 같은 모듈 스코프에서 직접 호출하게 되어, 테스트가
 * `jest.mock('.../backendSsotMirror', () => ({ ...jest.requireActual(...), readBackendSsotMirror:
 * jest.fn() }))`로 `readBackendSsotMirror`만 override해도 requireActual로 얻은 본 훅은 (컴파일된
 * CommonJS에서 동일 모듈 내부 함수 호출이 export 바인딩이 아니라 로컬 참조를 사용하므로) 그 mock을
 * 우회해 실제 AsyncStorage를 호출한다 — 기존 `useFusedNearestStation.backendSsotCascade` 등 mirror
 * fixture 기반 테스트 14건이 실제로 이 경로에서 깨지는 것을 확인(2026-09-14, 이 훅을
 * backendSsotMirror.ts에 내장한 시도 롤백). 이 파일에서 `readBackendSsotMirror`를 cross-module
 * import로 가져오면 jest의 모듈 레지스트리 치환이 정상적으로 개입해 소비처 테스트의 기존 mock이
 * 그대로 유효하다 — 그래서 "기존 테스트 무수정 green" 제약을 지키려면 이 위치가 유일한 선택지다.
 *
 * 순수 추출 — 동작/타이밍/조건 100% 동일:
 *   - 5s 간격 폴링(backend cycle ~30s 대비 충분히 빈번, 매 render read 방지)
 *   - receivedAt+currentStationId 동일 entry는 setState reducer가 prev를 그대로 반환(무의미한
 *     추가 render 방지, null→null 전이 포함)
 *   - unmount 시 cancelled 가드로 이미 진행 중인 read의 늦은 resolve가 setState하지 않도록 차단
 *
 * #2590 (code review 1번) — freshness(≤180s, `BACKEND_SSOT_MIRROR_MAX_AGE_MS`) 판정을 이 훅
 * 내부로 이동. 이전에는 각 소비처가 `Date.now() - receivedAt`을 자신의 useMemo 안에서 계산했는데,
 * 그 memo의 의존성 배열에 시간 자체가 없어(`backendSsotMirror`/`currentStation`/`lock` 등만 있음)
 * mirror entry가 그대로고 다른 의존성도 안 바뀌면 실제로 180s가 지나 stale이 되어도 memo가
 * 재평가되지 않아 "한 번 fresh였던 값이 영구 fresh로 갇히는" 버그가 있었다(useTransferTrainList처럼
 * 재렌더 트리거가 드문 소비처에서 특히 노출). 이제는 5s tick마다 `Date.now()` 기준으로 freshness를
 * 재평가해, 새 push 없이 시간만 지나도(entry 자체는 동일) stale 전이 시 mirror를 null로 되돌린다
 * — 이 훅을 쓰는 모든 소비처가 반환값(`!== null`)만으로 "지금 이 순간 fresh"를 신뢰할 수 있다.
 *
 * #2590 (code review 7번) — `enabled` 파라미터(기본 true, FG cascade picker 호출부는 인자 없이
 * 호출해 기존 동작 100% 동일 유지). `useTransferTrainList`처럼 route/여정이 활성일 때만 의미
 * 있는 소비처는 `enabled=false`로 넘겨 idle 사용자(여정 없음)의 5s AsyncStorage 폴링을
 * 완전히 멈춘다 — FG cascade picker가 이미 항상 폴링하므로, 여정 없는 상태에서까지 같은
 * 데이터를 이중으로 읽는 낭비를 없앤다. `enabled=false` 전환 시 보유 중이던 mirror도 null로
 * 비운다(재활성 시 stale 값을 들고 있지 않도록).
 */
import { useEffect, useState } from 'react';
import { readBackendSsotMirror } from '../utils/backendSsotMirror';
import type { BackendSsotMirrorEntry } from '../utils/backendSsotMirror';
import { BACKEND_SSOT_MIRROR_MAX_AGE_MS } from '../../../shared/constants/realtime';

export function useBackendSsotMirrorPoll(enabled = true): BackendSsotMirrorEntry | null {
  const [mirror, setMirror] = useState<BackendSsotMirrorEntry | null>(null);
  useEffect(() => {
    if (!enabled) {
      setMirror(null);
      return;
    }
    let cancelled = false;
    const tick = () => {
      void readBackendSsotMirror().then((raw) => {
        if (cancelled) return;
        const fresh =
          raw !== null && Date.now() - raw.receivedAt <= BACKEND_SSOT_MIRROR_MAX_AGE_MS;
        const entry = fresh ? raw : null;
        setMirror((prev) => {
          if (prev === null && entry === null) return prev;
          if (
            prev !== null &&
            entry !== null &&
            prev.receivedAt === entry.receivedAt &&
            prev.currentStationId === entry.currentStationId
          ) {
            return prev;
          }
          return entry;
        });
      });
    };
    // 첫 read는 5s interval 첫 tick에 맡긴다 — 마운트 직후 동기 read의 microtask resolve가
    // 첫 render commit phase와 겹쳐 act() warning을 발생시키는 회귀 차단(jest-expo setup).
    const id = setInterval(tick, 5_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [enabled]);
  return mirror;
}
