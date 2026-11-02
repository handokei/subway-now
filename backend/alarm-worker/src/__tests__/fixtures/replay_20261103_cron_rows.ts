/**
 * 실측 D1 `trip_events` cron-fire-attempt 33행 (ts >= 1793136706091) — #3006 술어 교체(PR-1) 기준선.
 * 2026-11-03 prod D1 read-only 조회 원문. **불변 — 통과시키려고 조정 금지.**
 * replay_20261103_reconsume_rows.ts(prepare-alarm/trip-end/advance 35행)와 같은 조회 구간의 짝 fixture.
 * 관측: 정상 dwell 은 sent 1 + station-passed-dedup 1 (중곡·군자·어린이대공원·청담 등).
 * 11/02 건대입구 사건은 head 성수에서 sync-station-passed-dedup 이 2회 (1973, 1980).
 */
import type { ReconsumeFixtureRow } from './replay_20261103_reconsume_rows';

export const REPLAY_20261103_CRON_ROWS: ReconsumeFixtureRow[] = [
  {
    "id": 1752,
    "ts": 1793136706091,
    "token_hash": "b00dd879",
    "kind": "cron-fire-attempt",
    "station": "군자(능동)",
    "meta": "{\"waypointKind\":\"station-passed\",\"phase\":\"imminent\",\"outcome\":\"skipped-reason\",\"reason\":\"station-passed-dedup\"}"
  },
  {
    "id": 1759,
    "ts": 1793136795916,
    "token_hash": "b00dd879",
    "kind": "cron-fire-attempt",
    "station": "어린이대공원(세종대)",
    "meta": "{\"waypointKind\":\"station-passed\",\"phase\":\"imminent\",\"outcome\":\"sent\",\"midCycle\":true,\"pushId\":\"24632120-7683-46ca-8ffb-67b687a765b8\"}"
  },
  {
    "id": 1760,
    "ts": 1793136825297,
    "token_hash": "b00dd879",
    "kind": "cron-fire-attempt",
    "station": "어린이대공원(세종대)",
    "meta": "{\"waypointKind\":\"station-passed\",\"phase\":\"imminent\",\"outcome\":\"skipped-reason\",\"reason\":\"station-passed-dedup\"}"
  },
  {
    "id": 1766,
    "ts": 1793136915234,
    "token_hash": "b00dd879",
    "kind": "cron-fire-attempt",
    "station": "건대입구",
    "meta": "{\"waypointKind\":\"transfer\",\"phase\":\"imminent\",\"outcome\":\"sent\",\"midCycle\":true,\"pushId\":\"6858d18a-986c-4815-9af0-fe900de2d847\"}"
  },
  {
    "id": 1768,
    "ts": 1793136945710,
    "token_hash": "b00dd879",
    "kind": "cron-fire-attempt",
    "station": "건대입구",
    "meta": "{\"waypointKind\":\"transfer\",\"phase\":\"imminent\",\"outcome\":\"skipped-reason\",\"reason\":\"ssot-not-at-or-approaching\"}"
  },
  {
    "id": 1790,
    "ts": 1793137395237,
    "token_hash": "b00dd879",
    "kind": "cron-fire-attempt",
    "station": "성수",
    "meta": "{\"waypointKind\":\"station-passed\",\"phase\":\"imminent\",\"outcome\":\"sent\",\"midCycle\":true,\"pushId\":\"b1e257ac-da87-4d24-ab3e-69186c5bfdbd\"}"
  },
  {
    "id": 1823,
    "ts": 1793176035681,
    "token_hash": "b00dd879",
    "kind": "cron-fire-attempt",
    "station": "어린이대공원(세종대)",
    "meta": "{\"waypointKind\":\"station-passed\",\"phase\":\"imminent\",\"outcome\":\"sent\",\"midCycle\":true,\"pushId\":\"dda395b3-c29e-4da2-b277-1ccbf23cf61d\"}"
  },
  {
    "id": 1824,
    "ts": 1793176065641,
    "token_hash": "b00dd879",
    "kind": "cron-fire-attempt",
    "station": "어린이대공원(세종대)",
    "meta": "{\"waypointKind\":\"station-passed\",\"phase\":\"imminent\",\"outcome\":\"skipped-reason\",\"reason\":\"station-passed-dedup\"}"
  },
  {
    "id": 1828,
    "ts": 1793176155586,
    "token_hash": "b00dd879",
    "kind": "cron-fire-attempt",
    "station": "군자(능동)",
    "meta": "{\"waypointKind\":\"station-passed\",\"phase\":\"imminent\",\"outcome\":\"sent\",\"midCycle\":true,\"pushId\":\"49be9598-3e82-4e02-b1d3-c399bac92248\"}"
  },
  {
    "id": 1829,
    "ts": 1793176185674,
    "token_hash": "b00dd879",
    "kind": "cron-fire-attempt",
    "station": "군자(능동)",
    "meta": "{\"waypointKind\":\"station-passed\",\"phase\":\"imminent\",\"outcome\":\"skipped-reason\",\"reason\":\"station-passed-dedup\"}"
  },
  {
    "id": 1831,
    "ts": 1793176305443,
    "token_hash": "b00dd879",
    "kind": "cron-fire-attempt",
    "station": "중곡",
    "meta": "{\"waypointKind\":\"station-passed\",\"phase\":\"imminent\",\"outcome\":\"sent\",\"pushId\":\"296a8bd1-28bf-4a0f-8d22-8eb847f8e7d4\"}"
  },
  {
    "id": 1833,
    "ts": 1793176426803,
    "token_hash": "b00dd879",
    "kind": "cron-fire-attempt",
    "station": "용마산",
    "meta": "{\"waypointKind\":\"destination\",\"phase\":\"imminent\",\"outcome\":\"sent\",\"pushId\":\"28953da6-1e80-40d7-86b3-f52fd013f1ee\"}"
  },
  {
    "id": 1873,
    "ts": 1793407305374,
    "token_hash": "b00dd879",
    "kind": "cron-fire-attempt",
    "station": "중곡",
    "meta": "{\"waypointKind\":\"station-passed\",\"phase\":\"imminent\",\"outcome\":\"sent\",\"path\":\"position-entering\",\"pushId\":\"baf2d190-4e9e-43da-8c01-05fec3aa91f4\"}"
  },
  {
    "id": 1875,
    "ts": 1793407365787,
    "token_hash": "b00dd879",
    "kind": "cron-fire-attempt",
    "station": "중곡",
    "meta": "{\"waypointKind\":\"station-passed\",\"phase\":\"imminent\",\"outcome\":\"skipped-reason\",\"reason\":\"station-passed-dedup\"}"
  },
  {
    "id": 1880,
    "ts": 1793407425324,
    "token_hash": "b00dd879",
    "kind": "cron-fire-attempt",
    "station": "군자(능동)",
    "meta": "{\"waypointKind\":\"station-passed\",\"phase\":\"imminent\",\"outcome\":\"sent\",\"path\":\"position-entering\",\"pushId\":\"e4c18944-fd70-46eb-bb96-ca9639ec62a5\"}"
  },
  {
    "id": 1883,
    "ts": 1793407485711,
    "token_hash": "b00dd879",
    "kind": "cron-fire-attempt",
    "station": "군자(능동)",
    "meta": "{\"waypointKind\":\"station-passed\",\"phase\":\"imminent\",\"outcome\":\"skipped-reason\",\"reason\":\"station-passed-dedup\"}"
  },
  {
    "id": 1887,
    "ts": 1793407575753,
    "token_hash": "b00dd879",
    "kind": "cron-fire-attempt",
    "station": "어린이대공원(세종대)",
    "meta": "{\"waypointKind\":\"station-passed\",\"phase\":\"imminent\",\"outcome\":\"sent\",\"midCycle\":true,\"path\":\"position-entering\",\"pushId\":\"218da28c-6d99-4077-a90b-acb81f4ce960\"}"
  },
  {
    "id": 1889,
    "ts": 1793407605190,
    "token_hash": "b00dd879",
    "kind": "cron-fire-attempt",
    "station": "어린이대공원(세종대)",
    "meta": "{\"waypointKind\":\"station-passed\",\"phase\":\"imminent\",\"outcome\":\"skipped-reason\",\"reason\":\"station-passed-dedup\"}"
  },
  {
    "id": 1893,
    "ts": 1793407695600,
    "token_hash": "b00dd879",
    "kind": "cron-fire-attempt",
    "station": "건대입구",
    "meta": "{\"waypointKind\":\"station-passed\",\"phase\":\"imminent\",\"outcome\":\"sent\",\"midCycle\":true,\"pushId\":\"7827e705-ba63-4278-8ce9-ec6768763c03\"}"
  },
  {
    "id": 1901,
    "ts": 1793407815046,
    "token_hash": "b00dd879",
    "kind": "cron-fire-attempt",
    "station": "자양(뚝섬한강공원)",
    "meta": "{\"waypointKind\":\"station-passed\",\"phase\":\"imminent\",\"outcome\":\"sent\",\"midCycle\":true,\"path\":\"position-entering\",\"pushId\":\"421920de-265a-4eac-80fe-95a80c2b65ba\"}"
  },
  {
    "id": 1908,
    "ts": 1793407995273,
    "token_hash": "b00dd879",
    "kind": "cron-fire-attempt",
    "station": "청담",
    "meta": "{\"waypointKind\":\"station-passed\",\"phase\":\"imminent\",\"outcome\":\"sent\",\"midCycle\":true,\"path\":\"position-entering\",\"pushId\":\"a8ad975f-a9ee-4de4-84c9-250dc1f8cd5e\"}"
  },
  {
    "id": 1910,
    "ts": 1793408025437,
    "token_hash": "b00dd879",
    "kind": "cron-fire-attempt",
    "station": "청담",
    "meta": "{\"waypointKind\":\"station-passed\",\"phase\":\"imminent\",\"outcome\":\"skipped-reason\",\"reason\":\"station-passed-dedup\"}"
  },
  {
    "id": 1914,
    "ts": 1793408145681,
    "token_hash": "b00dd879",
    "kind": "cron-fire-attempt",
    "station": "강남구청",
    "meta": "{\"waypointKind\":\"station-passed\",\"phase\":\"imminent\",\"outcome\":\"sent\",\"pushId\":\"33f5e2b5-686a-4e4a-9c4e-77ad78abb9b6\"}"
  },
  {
    "id": 1920,
    "ts": 1793408205271,
    "token_hash": "b00dd879",
    "kind": "cron-fire-attempt",
    "station": "강남구청",
    "meta": "{\"waypointKind\":\"station-passed\",\"phase\":\"imminent\",\"outcome\":\"skipped-reason\",\"reason\":\"station-passed-dedup\",\"path\":\"vanish-fallback\"}"
  },
  {
    "id": 1936,
    "ts": 1793408386378,
    "token_hash": "b00dd879",
    "kind": "cron-fire-attempt",
    "station": "학동",
    "meta": "{\"waypointKind\":\"station-passed\",\"phase\":\"imminent\",\"outcome\":\"sent\",\"path\":\"vanish-fallback\",\"pushId\":\"1a0fe502-24d7-4ee9-b35f-ef723ac5d3c0\"}"
  },
  {
    "id": 1969,
    "ts": 1793616435446,
    "token_hash": "b00dd879",
    "kind": "cron-fire-attempt",
    "station": "성수",
    "meta": "{\"waypointKind\":\"station-passed\",\"phase\":\"imminent\",\"outcome\":\"sent\",\"midCycle\":true,\"pushId\":\"9e109b9f-c666-4096-ad1f-778750df2283\"}"
  },
  {
    "id": 1973,
    "ts": 1793616545840,
    "token_hash": "b00dd879",
    "kind": "cron-fire-attempt",
    "station": "성수",
    "meta": "{\"waypointKind\":\"station-passed\",\"phase\":\"imminent\",\"outcome\":\"skipped-reason\",\"reason\":\"sync-station-passed-dedup\"}"
  },
  {
    "id": 1975,
    "ts": 1793616545840,
    "token_hash": "b00dd879",
    "kind": "cron-fire-attempt",
    "station": "건대입구",
    "meta": "{\"waypointKind\":\"transfer\",\"phase\":\"imminent\",\"outcome\":\"sent\",\"pushId\":\"334667be-70c9-485c-b3f6-f03e0920af34\"}"
  },
  {
    "id": 1980,
    "ts": 1793616556423,
    "token_hash": "b00dd879",
    "kind": "cron-fire-attempt",
    "station": "성수",
    "meta": "{\"waypointKind\":\"station-passed\",\"phase\":\"imminent\",\"outcome\":\"skipped-reason\",\"reason\":\"sync-station-passed-dedup\"}"
  },
  {
    "id": 2020,
    "ts": 1793617215269,
    "token_hash": "b00dd879",
    "kind": "cron-fire-attempt",
    "station": "중곡",
    "meta": "{\"waypointKind\":\"station-passed\",\"phase\":\"imminent\",\"outcome\":\"sent\",\"midCycle\":true,\"path\":\"position-entering\",\"pushId\":\"b9fe4124-d257-4a92-bb95-f648d1cacc46\"}"
  },
  {
    "id": 2021,
    "ts": 1793617245180,
    "token_hash": "b00dd879",
    "kind": "cron-fire-attempt",
    "station": "중곡",
    "meta": "{\"waypointKind\":\"station-passed\",\"phase\":\"imminent\",\"outcome\":\"skipped-reason\",\"reason\":\"station-passed-dedup\"}"
  },
  {
    "id": 2033,
    "ts": 1793617366764,
    "token_hash": "b00dd879",
    "kind": "cron-fire-attempt",
    "station": "용마산",
    "meta": "{\"waypointKind\":\"destination\",\"phase\":\"imminent\",\"outcome\":\"skipped-reason\",\"reason\":\"ssot-not-at-or-approaching\"}"
  },
  {
    "id": 2037,
    "ts": 1793617396301,
    "token_hash": "b00dd879",
    "kind": "cron-fire-attempt",
    "station": "용마산",
    "meta": "{\"waypointKind\":\"destination\",\"phase\":\"imminent\",\"outcome\":\"sent\",\"midCycle\":true,\"pushId\":\"197bb354-e33d-4231-874e-019ccc5953bd\"}"
  }
];
