# ADR-002: Provider 패턴 (인터페이스 추상화) 적용

## 상태

채택됨 (2025-04-14)

## 배경

기존 코드에서 `useArrivalInfo` 훅은 `fetchArrivalInfo` 함수를 직접 import하여 호출한다.
이는 서울 열린데이터 API의 구체적인 구현에 직접 의존하는 것으로, 다음 문제를 만든다:

```typescript
// AS-IS: 구체 구현에 직접 의존
import { fetchArrivalInfo } from '../api/arrivalApi';
```

- 다른 도착 정보 API로 교체하려면 훅 코드를 수정해야 한다
- 테스트 시 `jest.mock()`으로 모듈 전체를 교체해야 한다
- BFF 서버 도입 시 호출 방식이 완전히 달라진다

## 결정

외부 API 호출을 **Provider 인터페이스**로 추상화하고, **Factory 패턴**으로 런타임에 구현체를 결정한다.

```typescript
// TO-BE: 인터페이스에만 의존
interface ArrivalProvider {
  getArrival(stationName: string, options?: ArrivalOptions): Promise<StationArrival>
}
```

## 이유

1. **개방-폐쇄 원칙(OCP)**: 새 API 제공자 추가 시 기존 코드 수정 없이 Provider 구현체만 추가
2. **테스트 용이성**: 인터페이스 기반으로 MockProvider를 주입하여 깔끔한 단위 테스트
3. **BFF 전환 투명성**: BffArrivalProvider 추가 후 Factory에서 전환하면 훅 코드 변경 없음
4. **점진적 마이그레이션**: 기존 `arrivalApi.ts` 로직을 `SeoulOpenApiProvider`로 래핑하여 기존 동작 보존

## 구조

```
src/providers/
  types.ts                    ← 공통 인터페이스
  arrival/
    index.ts                  ← ArrivalProvider 인터페이스 + export
    SeoulOpenApiProvider.ts   ← 서울 열린데이터 구현
    BffArrivalProvider.ts     ← BFF 서버 호출 구현
    MockProvider.ts           ← 테스트용
  factory.ts                  ← createArrivalProvider()
```

## 트레이드오프

| 장점 | 단점 |
|------|------|
| 제공자 교체 시 코드 변경 최소화 | 인터페이스 + Factory 레이어 추가 |
| 테스트에서 깔끔한 DI | 단일 제공자만 쓸 때는 과설계로 보일 수 있음 |
| 훅이 구체 구현을 모름 | 초기 학습 비용 |

**판단**: 이미 BFF 도입이 예정되어 있으므로 최소 2개 Provider(직접 호출 + BFF)가 필요하다.
따라서 과설계가 아니라 필수적인 추상화이다.

## 결과

- 훅은 `ArrivalProvider` 인터페이스에만 의존하므로 구현체가 바뀌어도 훅 코드는 변경되지 않는다
- 환경변수로 Provider를 전환할 수 있어 개발/스테이징/프로덕션 환경별 설정이 가능하다
