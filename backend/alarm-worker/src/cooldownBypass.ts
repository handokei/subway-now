/**
 * #2912 — `#1425 trip-recently-ended` 쿨다운의 좁은 예외(destination-recovery) 우회 쿼터.
 *
 * 배경: 10/7 아침 사고(#2907 S12)에서 backend가 trip을 06:48:31 `destination`으로 조기 종료한
 * 뒤, 사용자는 실제로 목적지에 도달하지 않았는데(남은 waypoints 존재) `#1425` 쿨다운이 1시간
 * 동안 모든 재등록을 거부해 복구가 불가능했다. `index.ts`의 POST /trips 핸들러는 직전 종료
 * 사유가 `destination`이고 incoming payload의 waypoints가 비어있지 않을 때만 쿨다운을 우회한다
 * (validateTrip이 이미 구조 검증을 통과시킨 뒤라 waypoints 비배열/빈 배열은 이 지점에 도달하지
 * 않는다 — `index.ts:3481`).
 *
 * 쿼터 보호(이슈 금지 조건 ⓓ) — 우회는 race/오작동으로 무한 반복될 수 있는 탈출구이기도 하다.
 * 같은 token에 대해 rolling window(`COOLDOWN_BYPASS_WINDOW_MS`, #1425 retention과 동일 1h) 당
 * 최대 `DESTINATION_COOLDOWN_BYPASS_MAX`회만 우회를 허용하고, 초과분은 기존 쿨다운 거부로
 * fall back한다. 이 카운터는 `tripStatus:<token>` 마커(#2144가 register 성공 시 삭제)와
 * **독립적인 키**(`cooldownBypass:<token>`)로 유지한다 — 우회가 성공해 trip이 다시 정상 등록되고
 * tripStatus 마커가 삭제된 뒤에도, 같은 token이 짧은 시간 안에 "destination 종료 → 우회" 사이클을
 * 반복하면(버그/남용 신호) 누적 count가 그대로 유지돼 상한에 걸린다.
 *
 * Free plan KV quota 보호 — 쿼터 소진 lesson(#2073)과 동일하게, 이 카운터는 우회가 실제로
 * 발생한 시점에만(= destination 쿨다운에 실제로 걸렸을 때만) write한다. 매 POST/매 cron tick에
 * 쓰지 않는다.
 */

const COOLDOWN_BYPASS_PREFIX = 'cooldownBypass:';

/** 같은 token에 대해 rolling window 안에서 허용하는 최대 우회 횟수. */
export const DESTINATION_COOLDOWN_BYPASS_MAX = 3;

/** rolling window 길이(ms) — `#1425` retention(1h)과 동일하게 맞춘다. */
export const COOLDOWN_BYPASS_WINDOW_MS = 60 * 60 * 1000;

/** KV expirationTtl(초) — window보다 여유를 둬 판정 경계 직전 read가 null로 떨어지지 않게 한다. */
const COOLDOWN_BYPASS_TTL_SEC = Math.ceil(COOLDOWN_BYPASS_WINDOW_MS / 1000) + 60;

interface CooldownBypassRecord {
  count: number;
  windowStartedAt: number;
}

function cooldownBypassKey(token: string): string {
  return `${COOLDOWN_BYPASS_PREFIX}${token}`;
}

function parseRecord(raw: string | null): CooldownBypassRecord | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CooldownBypassRecord>;
    if (typeof parsed.count !== 'number' || typeof parsed.windowStartedAt !== 'number') {
      return null;
    }
    return { count: parsed.count, windowStartedAt: parsed.windowStartedAt };
  } catch {
    return null;
  }
}

/**
 * 우회 시도 1건을 쿼터에 소비 시도한다.
 *
 * - window가 없거나(최초) 지난 window가 `COOLDOWN_BYPASS_WINDOW_MS`를 넘었으면 새 window로
 *   리셋하고 count=1로 허용.
 * - 현재 window 안에서 count가 `DESTINATION_COOLDOWN_BYPASS_MAX` 미만이면 증가시키고 허용.
 * - 상한에 도달했으면 KV를 건드리지 않고 거부(`allowed: false`) — 호출자는 기존 #1425 쿨다운
 *   거부로 fall back한다.
 *
 * @returns `allowed` — 우회 허용 여부. `count` — 이번 호출 반영 후(또는 상한 도달 시 그대로의) count.
 */
export async function tryConsumeCooldownBypass(
  kv: KVNamespace,
  token: string,
  now: number = Date.now(),
): Promise<{ allowed: boolean; count: number }> {
  const raw = await kv.get(cooldownBypassKey(token));
  const existing = parseRecord(raw);
  const withinWindow = existing !== null && now - existing.windowStartedAt < COOLDOWN_BYPASS_WINDOW_MS;
  const current: CooldownBypassRecord = withinWindow
    ? existing
    : { count: 0, windowStartedAt: now };

  if (current.count >= DESTINATION_COOLDOWN_BYPASS_MAX) {
    return { allowed: false, count: current.count };
  }

  const next: CooldownBypassRecord = { count: current.count + 1, windowStartedAt: current.windowStartedAt };
  await kv.put(cooldownBypassKey(token), JSON.stringify(next), {
    expirationTtl: COOLDOWN_BYPASS_TTL_SEC,
  });
  return { allowed: true, count: next.count };
}
