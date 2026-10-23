import type { ArrivalInfo } from '../types/arrival';

/**
 * 도착 list 필터 술어 — #897 (Seam A) / #3029. arrivalSeconds 음수(이미 지나간 열차)만 제외하고
 * 임박(0초)은 유지한다. 0초 행이 tick으로 사라지면 사용자가 다음 차를 같은 차로 오인하는 회귀가 있다.
 * 홈 목록(useBoardingLockController)과 환승 목록(useTransferTrainList)이 같은 정책을 공유하는 SSOT.
 */
export const isReachable = (train: ArrivalInfo): boolean =>
  // #3132 — 시간 모름(null, 코레일 barvlDt=0)은 "지나간 열차"가 아니므로 목록에 포함.
  train.arrivalSeconds === null || train.arrivalSeconds >= 0;
