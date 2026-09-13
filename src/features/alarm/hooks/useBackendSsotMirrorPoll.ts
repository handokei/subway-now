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
 * freshness(≤180s, `BACKEND_SSOT_MIRROR_MAX_AGE_MS`) 판정과 `resolveBackendSsotMirrorStation`
 * 호출은 각 소비처가 lock/route 등 자신의 컨텍스트에 맞춰 별도로 수행한다(그 로직은 소비처마다
 * 달라 공유 대상이 아님 — 실제 중복은 이 폴링 boilerplate뿐이었다).
 */
import { useEffect, useState } from 'react';
import { readBackendSsotMirror } from '../utils/backendSsotMirror';
import type { BackendSsotMirrorEntry } from '../utils/backendSsotMirror';

export function useBackendSsotMirrorPoll(): BackendSsotMirrorEntry | null {
  const [mirror, setMirror] = useState<BackendSsotMirrorEntry | null>(null);
  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      void readBackendSsotMirror().then((entry) => {
        if (cancelled) return;
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
  }, []);
  return mirror;
}
