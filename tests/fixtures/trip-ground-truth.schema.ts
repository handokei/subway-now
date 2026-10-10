/**
 * Gold standard trip fixture schema (P0-4 / #1580).
 *
 * 사용자가 직접 annotation한 trip 5건을 ground truth로 박제하여
 * V/X acceptance 검증의 self-referential 문제를 해결한다.
 *
 * 사용자는 `trip-ground-truth-{date}-{seq}.json` 형식으로 fixture 파일을 추가하면 된다.
 * 본 schema는 그 파일이 read-time에 valid한지 검증한다.
 *
 * Phase 0 epic #1576 — sub-task #1580. 인프라 PR (사용자 입력 제외).
 */

export type TripEnvironment = 'underground' | 'surface' | 'hybrid';

export interface ActualStation {
  /** stations.json id (예: "2-035"). */
  stationId: string;
  /** 표시명 (예: "건대입구"). diff 시 human-readable). */
  name: string;
  arrivedAt: string;
  departedAt: string;
}

export interface ActualTransfer {
  /** 환승 시작 역 (이전 노선의 마지막 역). */
  fromStationId: string;
  /** 환승해 들어간 노선 id (예: "1"). */
  toLineId: string;
  /** 환승역 도착 시각. */
  arrivedAt: string;
  /** 새 노선 열차 출발 시각 (= 환승 완료). */
  departedAt: string;
}

export interface ActualDestination {
  stationId: string;
  name: string;
  arrivedAt: string;
}

export interface TripGroundTruth {
  tripStartedAt: string;
  tripEndedAt: string;
  actualStations: ActualStation[];
  actualTransfers: ActualTransfer[];
  actualDestination: ActualDestination;
  environment: TripEnvironment;
  lineIds: string[];
  notes: string;
}

export interface ValidationIssue {
  path: string;
  message: string;
}

const ENVIRONMENTS = new Set<TripEnvironment>(['underground', 'surface', 'hybrid']);

const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function isIso(value: unknown): value is string {
  return typeof value === 'string' && ISO_PATTERN.test(value) && !Number.isNaN(Date.parse(value));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function checkIso(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!isIso(value)) {
    issues.push({ path, message: `ISO 8601 datetime 형식이 아님` });
  }
}

function checkString(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!isNonEmptyString(value)) {
    issues.push({ path, message: `비어있지 않은 string 필수` });
  }
}

function checkStation(input: unknown, path: string, issues: ValidationIssue[]): void {
  if (!input || typeof input !== 'object') {
    issues.push({ path, message: 'object 필수' });
    return;
  }
  const obj = input as Record<string, unknown>;
  checkString(obj.stationId, `${path}.stationId`, issues);
  checkString(obj.name, `${path}.name`, issues);
  checkIso(obj.arrivedAt, `${path}.arrivedAt`, issues);
  checkIso(obj.departedAt, `${path}.departedAt`, issues);
}

function checkTransfer(input: unknown, path: string, issues: ValidationIssue[]): void {
  if (!input || typeof input !== 'object') {
    issues.push({ path, message: 'object 필수' });
    return;
  }
  const obj = input as Record<string, unknown>;
  checkString(obj.fromStationId, `${path}.fromStationId`, issues);
  checkString(obj.toLineId, `${path}.toLineId`, issues);
  checkIso(obj.arrivedAt, `${path}.arrivedAt`, issues);
  checkIso(obj.departedAt, `${path}.departedAt`, issues);
}

function checkDestination(input: unknown, path: string, issues: ValidationIssue[]): void {
  if (!input || typeof input !== 'object') {
    issues.push({ path, message: 'object 필수' });
    return;
  }
  const obj = input as Record<string, unknown>;
  checkString(obj.stationId, `${path}.stationId`, issues);
  checkString(obj.name, `${path}.name`, issues);
  checkIso(obj.arrivedAt, `${path}.arrivedAt`, issues);
}

/**
 * 런타임에 임의 JSON이 TripGroundTruth schema에 맞는지 검증한다.
 * issues 배열이 비어 있으면 valid.
 */
export function validateTripGroundTruth(input: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!input || typeof input !== 'object') {
    issues.push({ path: '$', message: 'root는 object여야 함' });
    return issues;
  }
  const obj = input as Record<string, unknown>;

  checkIso(obj.tripStartedAt, 'tripStartedAt', issues);
  checkIso(obj.tripEndedAt, 'tripEndedAt', issues);

  if (!Array.isArray(obj.actualStations) || obj.actualStations.length === 0) {
    issues.push({ path: 'actualStations', message: '최소 1개 이상의 actualStation 필수' });
  } else {
    obj.actualStations.forEach((s, i) => checkStation(s, `actualStations[${i}]`, issues));
  }

  if (Array.isArray(obj.actualTransfers)) {
    obj.actualTransfers.forEach((t, i) => checkTransfer(t, `actualTransfers[${i}]`, issues));
  } else {
    issues.push({ path: 'actualTransfers', message: '배열 필수 (환승 없으면 빈 배열)' });
  }

  checkDestination(obj.actualDestination, 'actualDestination', issues);

  if (!ENVIRONMENTS.has(obj.environment as TripEnvironment)) {
    issues.push({
      path: 'environment',
      message: `'underground' | 'surface' | 'hybrid' 중 하나여야 함`,
    });
  }

  if (!Array.isArray(obj.lineIds) || obj.lineIds.length === 0 || !obj.lineIds.every(isNonEmptyString)) {
    issues.push({ path: 'lineIds', message: '비어있지 않은 string의 비어있지 않은 배열 필수' });
  }

  if (typeof obj.notes !== 'string') {
    issues.push({ path: 'notes', message: 'string 필수 (빈 문자열 허용)' });
  }

  return issues;
}

/**
 * 검증 + 타입 narrow. fixture loader에서 사용.
 * 실패 시 issues를 합쳐 throw.
 */
export function parseTripGroundTruth(input: unknown): TripGroundTruth {
  const issues = validateTripGroundTruth(input);
  if (issues.length > 0) {
    const summary = issues.map((i) => `  - ${i.path}: ${i.message}`).join('\n');
    throw new Error(`TripGroundTruth schema 위반:\n${summary}`);
  }
  return input as TripGroundTruth;
}
