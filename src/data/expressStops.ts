/**
 * 노선별 급행/특급/ITX 정차역 목록.
 *
 * 키는 `LineNumber` (`src/types/station.ts`)와 `stations.json`의 `name`이다.
 * 새 노선/타입을 추가할 때는 이 파일 한 곳만 수정한다.
 *
 * 출처/갱신 정책: docs/decisions/ADR-005-express-stops-dataset.md
 * 기준일: 2026-05-30
 *
 * 주의: `stations.json`에 존재하는 역만 포함한다. 1호선 경부선 수원 이남 구간,
 * 9호선 가락시장 등은 stations.json에서 해당 노선으로 등록되지 않아
 * 의도적으로 제외한다(앱이 그 역들을 모르므로 매칭 자체가 발생하지 않음).
 * stations.json 보완 시 이 목록도 함께 확장한다.
 */

import type { TrainType } from '../shared/constants/trainTypes';
import type { LineNumber } from '../types/station';

export type ExpressStopsByType = Partial<Record<TrainType, ReadonlySet<string>>>;

const set = (names: readonly string[]): ReadonlySet<string> => new Set(names);

export const EXPRESS_STOPS: Partial<Record<LineNumber, ExpressStopsByType>> = {
  // 1호선 — 경부선(서울역↔영등포) + 경인선(용산↔동인천) 급행 합집합.
  // 경부선 수원 이남(안양·수원·천안 등)은 stations.json 미포함으로 제외.
  '1': {
    express: set([
      '서울역', '영등포',
      '용산', '노량진', '신도림', '구로', '개봉', '역곡', '부천', '송내',
      '부평', '백운', '동암', '주안', '제물포', '동인천',
    ]),
  },

  // 9호선 급행 — 가락시장은 stations.json에 9호선으로 미등록(제외).
  '9': {
    express: set([
      '개화', '김포공항', '마곡나루', '가양', '염창', '당산', '여의도',
      '노량진', '동작', '고속터미널', '신논현', '선정릉', '삼성중앙',
      '봉은사', '종합운동장', '석촌', '한성백제', '둔촌오륜', '중앙보훈병원',
      '올림픽공원',
    ]),
  },

  // 수인분당선 급행 (왕십리 ↔ 수원). 선릉 → 수서 구간은 직통(한티/도곡 비정차).
  bundang: {
    express: set([
      '왕십리', '청량리', '선릉', '수서', '모란',
      '야탑', '서현', '수내', '정자', '미금', '오리', '죽전', '기흥',
      '영통', '수원',
    ]),
  },

  // 경의중앙선 급행 (문산 ↔ 용문). 일부 역은 stations.json에 부제 포함 이름으로 등록됨.
  gyeongui: {
    express: set([
      '문산', '금촌', '운정', '일산', '디지털미디어시티', '홍대입구',
      '공덕', '서울역', '용산', '이촌(국립중앙박물관)', '옥수',
      '왕십리(성동구청)', '청량리(서울시립대입구)', '회기',
      '상봉(시외버스터미널)', '망우',
      '구리', '도농', '덕소', '팔당', '양수', '국수', '양평', '용문',
    ]),
  },

  // 공항철도 직통열차 (서울역 ↔ 인천공항).
  // ITX·특급 카테고리 매핑이 애매해 `rapid`로 분류.
  airport: {
    rapid: set(['서울역', '인천공항1터미널', '인천공항2터미널']),
  },

  // 경춘선 ITX-청춘/특급은 LineNumber 타입과 stations.json에 미포함.
  // 데이터 확장 후 별도 이슈로 추가.
};
