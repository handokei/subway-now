/**
 * #3366 — 버그 신고 "어디서 틀렸나요?" 유형. backend `POST /feedback` report.category enum과 동일.
 * 라벨은 i18n `feedback.category.<id>`(ko/en/ja/zh).
 */
export const FEEDBACK_CATEGORIES = [
  'alarm-missing',
  'alarm-late',
  'alarm-early',
  'wrong-station',
  'wrong-door',
  'boarding-not-detected',
  'other',
] as const;

export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];
