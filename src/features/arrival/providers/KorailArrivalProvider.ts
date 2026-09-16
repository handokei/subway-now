import type { ArrivalProvider, ArrivalOptions } from './types';
import type { StationArrival } from '../api/arrivalApi';
import { createLogger } from '../../../shared/utils/logger';

const log = createLogger('KorailArrivalProvider');

/**
 * 한국철도공사 열차운행정보 API provider (#1096 PoC).
 *
 * 데이터포털 15125762 endpoint 기반. PoC 단계에서는 API 키 발급이 완료되지 않아
 * 실제 endpoint 매핑/응답 정규화는 후속 PR로 미룬다. 본 클래스의 책임은:
 *   1. 키가 없으면 즉시 `null`을 반환해 CompositeArrivalProvider가 서울 OD로 fallback하게 한다.
 *   2. 키가 있으면 endpoint를 호출하고, 응답을 기존 StationArrival 스키마로 정규화한다.
 *      (현재 stub — 후속 PR에서 실제 변환 로직 추가)
 *
 * graceful 계약: 호출자(Composite)는 `null`을 "데이터 없음 — 다음 provider로"로 해석한다.
 * 예외 throw는 환경 오류로만 사용 — 빈 응답/스키마 불일치는 `null`로 흡수한다.
 */
export class KorailArrivalProvider {
  constructor(private readonly apiKey: string | undefined) {}

  /** 키 미설정/PoC stub 상태 판정. CompositeArrivalProvider가 호출 전 분기 가능. */
  get isAvailable(): boolean {
    return Boolean(this.apiKey);
  }

  async getArrival(
    stationName: string,
    _options?: ArrivalOptions,
  ): Promise<StationArrival | null> {
    if (!this.apiKey) {
      log.info('korail_skip_no_api_key', { station: stationName });
      return null;
    }

    // PoC stub: 실제 API endpoint/스키마 매핑은 키 발급 후 후속 PR에서 구현한다.
    // 키가 설정된 환경에서도 정상 동작 보장을 위해 현 시점에서는 명시적으로 null을 반환.
    log.info('korail_stub_not_implemented', { station: stationName });
    return null;
  }
}

/**
 * ArrivalProvider 인터페이스에 호환되는 Provider를 만들기 위한 helper.
 * Composite는 내부적으로 KorailArrivalProvider의 nullable 응답을 직접 다루기 때문에
 * 단독으로 사용할 일은 거의 없지만, factory에서 inject할 때 일관된 생성자를 제공한다.
 */
export function createKorailArrivalProvider(): KorailArrivalProvider {
  return new KorailArrivalProvider(process.env.EXPO_PUBLIC_KORAIL_API_KEY);
}
