/**
 * #1833 — DebugModal dump 텍스트 → DumpFixture 파싱.
 *
 * DebugModal share dump의 section 포맷:
 *   ## SectionName\n
 *   key=value\n
 *   ...
 *
 * 파싱 대상 필드만 추출. 파싱 불가 필드는 undefined — caller(fixtureChainRunner)가 graceful 처리.
 *
 * Privacy 정책:
 *   - apnsToken: 마지막 8자 이후는 이미 dump에서 `…XXXXXXXX` 형태로 마스킹됨 → 그대로 보존.
 *   - lat/lng: 소수점 2자리까지만 파싱 → 역 수준 정확도만 (chain 재현에 무관).
 *   - tripToken: URL에 포함된 경우 앞 8자만 보존 (SHA-256 prefix).
 */

export interface DumpFixture {
  /** ISO 타임스탬프 (dump 상단 "[Subway debug] ..." 줄). */
  capturedAt: string | undefined;

  /** ## Trip 섹션 */
  tripStartedAt: string | undefined;  // "—" (미시작) or 시간 문자열
  lifecyclePhase: string | undefined; // 'none' | 'active' | ...

  /** ## Fusion 섹션 */
  fusionConfidence: string | undefined; // 'gps-only' | 'gps-only-underground' | ...
  subsurface: boolean | undefined;      // true = 지하

  /** ## Silent Push 섹션 */
  silentPushReceived: number | undefined;  // 숫자 (received=N)
  silentPushFired: number | undefined;     // 숫자 (fired=N)

  /** ## BoardingLock 섹션 */
  boardingLockActive: boolean | undefined; // active=yes → true

  /** ## Alarm log 섹션 sources 행. 예: "boarding-prompt=1, fg=30, ..." */
  alarmLogSources: Record<string, number>;

  /** ## Notifications fired (N) 섹션 헤더의 N */
  notificationsFiredCount: number | undefined;

  /** fired 알람 종류 집합. 예: ['station-passed', 'transfer'] */
  notificationKinds: string[];
}

/**
 * DebugModal dump 텍스트를 DumpFixture로 파싱.
 *
 * 섹션 헤더 `## X`를 기준으로 split한 뒤 각 섹션을 개별 파싱.
 * 섹션 부재나 값 누락은 undefined/빈값으로 graceful 반환 — throw 없음.
 */
export function parseDumpFixture(text: string): DumpFixture {
  return {
    capturedAt: parseCapturedAt(text),
    tripStartedAt: parseTripField(text, 'tripStartedAt'),
    lifecyclePhase: parseTripField(text, 'lifecyclePhase'),
    fusionConfidence: parseFusionConfidence(text),
    subsurface: parseSubsurface(text),
    silentPushReceived: parseSilentPushCount(text, 'received'),
    silentPushFired: parseSilentPushCount(text, 'fired'),
    boardingLockActive: parseBoardingLockActive(text),
    alarmLogSources: parseAlarmLogSources(text),
    notificationsFiredCount: parseNotificationsFiredCount(text),
    notificationKinds: parseNotificationKinds(text),
  };
}

// --- 개별 파싱 함수 ---

function parseCapturedAt(text: string): string | undefined {
  const m = text.match(/^\[Subway debug\]\s+(\S+)/m);
  return m ? m[1] : undefined;
}

function parseTripField(text: string, key: string): string | undefined {
  const section = extractSection(text, 'Trip');
  if (!section) return undefined;
  const m = section.match(new RegExp(`^${key}=(.+)$`, 'm'));
  return m ? m[1].trim() : undefined;
}

function parseFusionConfidence(text: string): string | undefined {
  const section = extractSection(text, 'Fusion');
  if (!section) return undefined;
  const m = section.match(/^confidence=([^,\n]+)/m);
  return m ? m[1].trim() : undefined;
}

function parseSubsurface(text: string): boolean | undefined {
  const section = extractSection(text, 'GPS');
  if (!section) return undefined;
  // "subsurface=true (reason=...)" or "subsurface=false (reason=...)"
  const m = section.match(/^subsurface=(true|false)/m);
  if (!m) return undefined;
  return m[1] === 'true';
}

function parseSilentPushCount(text: string, field: 'received' | 'fired'): number | undefined {
  const section = extractSection(text, 'Silent Push');
  if (!section) return undefined;
  // "received=6 (last 08:38:43)" or "fired=0 (last (never))"
  const m = section.match(new RegExp(`^${field}=(\\d+)`, 'm'));
  return m ? parseInt(m[1], 10) : undefined;
}

function parseBoardingLockActive(text: string): boolean | undefined {
  const section = extractSection(text, 'BoardingLock');
  if (!section) return undefined;
  const m = section.match(/^active=(yes|no)$/m);
  if (!m) return undefined;
  return m[1] === 'yes';
}

function parseAlarmLogSources(text: string): Record<string, number> {
  const section = extractSection(text, 'Alarm log');
  if (!section) return {};
  // "sources: boarding-prompt=1, fg=30, fg-arvlcd=17, ..."
  const m = section.match(/^sources:\s*(.+)$/m);
  if (!m) return {};
  const result: Record<string, number> = {};
  for (const pair of m[1].split(',')) {
    const trimmed = pair.trim();
    const eq = trimmed.lastIndexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = parseInt(trimmed.slice(eq + 1).trim(), 10);
    if (key && !isNaN(val)) result[key] = val;
  }
  return result;
}

function parseNotificationsFiredCount(text: string): number | undefined {
  // "## Notifications fired (N)"
  const m = text.match(/^## Notifications fired \((\d+)\)/m);
  return m ? parseInt(m[1], 10) : undefined;
}

function parseNotificationKinds(text: string): string[] {
  const section = extractSection(text, 'Notifications fired');
  if (!section) return [];
  const kinds = new Set<string>();
  // "08:44:25 | fg | fired | station-passed | 성수"
  for (const line of section.split('\n')) {
    const parts = line.split('|').map((p) => p.trim());
    // parts[3] = 알람 종류 (station-passed / transfer / destination)
    if (parts.length >= 4 && parts[2] === 'fired') {
      kinds.add(parts[3]);
    }
  }
  return [...kinds];
}

/**
 * `## SectionName` 헤더 이후의 텍스트를 추출.
 * 다음 `## ` 헤더가 나오면 중단 (sectioned 블록).
 */
function extractSection(text: string, sectionName: string): string | undefined {
  const header = `## ${sectionName}`;
  const start = text.indexOf(header);
  if (start === -1) return undefined;
  const bodyStart = start + header.length;
  const nextSection = text.indexOf('\n## ', bodyStart);
  const body = nextSection === -1 ? text.slice(bodyStart) : text.slice(bodyStart, nextSection);
  return body;
}
