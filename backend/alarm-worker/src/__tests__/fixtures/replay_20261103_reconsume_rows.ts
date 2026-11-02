/**
 * 실측 D1 `trip_events` 35행 (prepare-alarm 21 + trip-end 9 + advance 5, ts >= 1793136706091) — #3006 재진행 감시 기준선.
 * 2026-11-03 prod D1 read-only 조회 원문. **불변 — 통과시키려고 조정 금지.**
 * 기대: 같은 트립 창 안 같은 역 prepare-alarm 2회+ = 정확히 2건 (강남구청 ×4: 1915/1921/1926/1929, 건대입구 ×2: 1974/1981).
 * advance를 술어에 포함하면 거짓양성 3건(어린이대공원 1810+1825, 청담 1903+1911, 어린이대공원 1976+1984)이 더해져 5건이 된다.
 */
export interface ReconsumeFixtureRow {
  id: number;
  ts: number;
  token_hash: string;
  kind: string;
  station: string | null;
  meta: string | null;
}

export const REPLAY_20261103_RECONSUME_ROWS: ReconsumeFixtureRow[] = [
  {
    "id": 1753,
    "ts": 1793136706091,
    "token_hash": "b00dd879",
    "kind": "prepare-alarm",
    "station": "군자(능동)",
    "meta": "{\"outcome\":\"skipped\",\"reason\":\"not-preceding\"}"
  },
  {
    "id": 1761,
    "ts": 1793136825297,
    "token_hash": "b00dd879",
    "kind": "prepare-alarm",
    "station": "어린이대공원(세종대)",
    "meta": "{\"outcome\":\"fired\",\"targetStation\":\"건대입구\",\"targetKind\":\"transfer\",\"pushId\":\"392fff33-7068-477a-8a0f-dcab3788f934\"}"
  },
  {
    "id": 1769,
    "ts": 1793136945710,
    "token_hash": "b00dd879",
    "kind": "prepare-alarm",
    "station": "건대입구",
    "meta": "{\"outcome\":\"skipped\",\"reason\":\"not-preceding\"}"
  },
  {
    "id": 1793,
    "ts": 1793137399491,
    "token_hash": "b00dd879",
    "kind": "prepare-alarm",
    "station": "성수",
    "meta": "{\"outcome\":\"fired\",\"targetStation\":\"뚝섬\",\"targetKind\":\"destination\",\"pushId\":\"8108a803-a9bf-4719-88e2-b92f71ed0009\"}"
  },
  {
    "id": 1792,
    "ts": 1793137400166,
    "token_hash": "b00dd879",
    "kind": "advance",
    "station": "뚝섬",
    "meta": "{\"shiftedCount\":1}"
  },
  {
    "id": 1798,
    "ts": 1793137530951,
    "token_hash": "b00dd879",
    "kind": "trip-end",
    "station": "2-010",
    "meta": "{\"reason\":\"arrival-auto-clear\",\"endPath\":\"http-delete\"}"
  },
  {
    "id": 1809,
    "ts": 1793175426379,
    "token_hash": "b00dd879",
    "kind": "prepare-alarm",
    "station": "건대입구",
    "meta": "{\"outcome\":\"skipped\",\"reason\":\"not-preceding\"}"
  },
  {
    "id": 1810,
    "ts": 1793175430140,
    "token_hash": "b00dd879",
    "kind": "advance",
    "station": "어린이대공원(세종대)",
    "meta": "{\"shiftedCount\":1}"
  },
  {
    "id": 1825,
    "ts": 1793176065641,
    "token_hash": "b00dd879",
    "kind": "prepare-alarm",
    "station": "어린이대공원(세종대)",
    "meta": "{\"outcome\":\"skipped\",\"reason\":\"not-preceding\"}"
  },
  {
    "id": 1830,
    "ts": 1793176185674,
    "token_hash": "b00dd879",
    "kind": "prepare-alarm",
    "station": "군자(능동)",
    "meta": "{\"outcome\":\"skipped\",\"reason\":\"not-preceding\"}"
  },
  {
    "id": 1832,
    "ts": 1793176305443,
    "token_hash": "b00dd879",
    "kind": "prepare-alarm",
    "station": "중곡",
    "meta": "{\"outcome\":\"fired\",\"targetStation\":\"용마산\",\"targetKind\":\"destination\",\"pushId\":\"6b3203bb-08e3-408f-abf9-079e858c17a1\"}"
  },
  {
    "id": 1835,
    "ts": 1793176441468,
    "token_hash": "b00dd879",
    "kind": "trip-end",
    "station": "7-015",
    "meta": "{\"reason\":\"destination-arrived\",\"endPath\":\"lock-active-destination\"}"
  },
  {
    "id": 1848,
    "ts": 1793186873910,
    "token_hash": "b00dd879",
    "kind": "trip-end",
    "station": "3-008",
    "meta": "{\"reason\":\"user-clear\",\"endPath\":\"http-delete\"}"
  },
  {
    "id": 1852,
    "ts": 1793359705673,
    "token_hash": "b00dd879",
    "kind": "trip-end",
    "station": "3-008",
    "meta": "{\"reason\":\"hydration-safety-net\",\"endPath\":\"http-delete\"}"
  },
  {
    "id": 1860,
    "ts": 1793360481867,
    "token_hash": "b00dd879",
    "kind": "trip-end",
    "station": "2-010",
    "meta": "{\"reason\":\"user-clear\",\"endPath\":\"http-delete\"}"
  },
  {
    "id": 1876,
    "ts": 1793407365787,
    "token_hash": "b00dd879",
    "kind": "prepare-alarm",
    "station": "중곡",
    "meta": "{\"outcome\":\"skipped\",\"reason\":\"not-preceding\"}"
  },
  {
    "id": 1884,
    "ts": 1793407485711,
    "token_hash": "b00dd879",
    "kind": "prepare-alarm",
    "station": "군자(능동)",
    "meta": "{\"outcome\":\"skipped\",\"reason\":\"not-preceding\"}"
  },
  {
    "id": 1890,
    "ts": 1793407605190,
    "token_hash": "b00dd879",
    "kind": "prepare-alarm",
    "station": "어린이대공원(세종대)",
    "meta": "{\"outcome\":\"skipped\",\"reason\":\"not-preceding\"}"
  },
  {
    "id": 1897,
    "ts": 1793407704843,
    "token_hash": "b00dd879",
    "kind": "advance",
    "station": "자양(뚝섬한강공원)",
    "meta": "{\"shiftedCount\":1}"
  },
  {
    "id": 1903,
    "ts": 1793407835901,
    "token_hash": "b00dd879",
    "kind": "advance",
    "station": "청담",
    "meta": "{\"shiftedCount\":1}"
  },
  {
    "id": 1911,
    "ts": 1793408025437,
    "token_hash": "b00dd879",
    "kind": "prepare-alarm",
    "station": "청담",
    "meta": "{\"outcome\":\"skipped\",\"reason\":\"not-preceding\"}"
  },
  {
    "id": 1915,
    "ts": 1793408145681,
    "token_hash": "b00dd879",
    "kind": "prepare-alarm",
    "station": "강남구청",
    "meta": "{\"outcome\":\"skipped\",\"reason\":\"not-preceding\"}"
  },
  {
    "id": 1921,
    "ts": 1793408205271,
    "token_hash": "b00dd879",
    "kind": "prepare-alarm",
    "station": "강남구청",
    "meta": "{\"outcome\":\"skipped\",\"reason\":\"not-preceding\"}"
  },
  {
    "id": 1926,
    "ts": 1793408265719,
    "token_hash": "b00dd879",
    "kind": "prepare-alarm",
    "station": "강남구청",
    "meta": "{\"outcome\":\"skipped\",\"reason\":\"not-preceding\"}"
  },
  {
    "id": 1929,
    "ts": 1793408326084,
    "token_hash": "b00dd879",
    "kind": "prepare-alarm",
    "station": "강남구청",
    "meta": "{\"outcome\":\"skipped\",\"reason\":\"not-preceding\"}"
  },
  {
    "id": 1937,
    "ts": 1793408386378,
    "token_hash": "b00dd879",
    "kind": "prepare-alarm",
    "station": "학동",
    "meta": "{\"outcome\":\"fired\",\"targetStation\":\"논현\",\"targetKind\":\"destination\",\"pushId\":\"533415cb-3e7e-4c14-a826-04cd60c4533b\"}"
  },
  {
    "id": 1940,
    "ts": 1793408396706,
    "token_hash": "b00dd879",
    "kind": "trip-end",
    "station": "7-024",
    "meta": "{\"reason\":\"arrival-auto-clear\",\"endPath\":\"http-delete\"}"
  },
  {
    "id": 1948,
    "ts": 1793569392575,
    "token_hash": "b00dd879",
    "kind": "trip-end",
    "station": "2-010",
    "meta": "{\"reason\":\"user-clear\",\"endPath\":\"http-delete\"}"
  },
  {
    "id": 1974,
    "ts": 1793616545840,
    "token_hash": "b00dd879",
    "kind": "prepare-alarm",
    "station": "건대입구",
    "meta": "{\"outcome\":\"skipped\",\"reason\":\"not-preceding\"}"
  },
  {
    "id": 1976,
    "ts": 1793616550814,
    "token_hash": "b00dd879",
    "kind": "advance",
    "station": "어린이대공원(세종대)",
    "meta": "{\"shiftedCount\":2}"
  },
  {
    "id": 1981,
    "ts": 1793616556423,
    "token_hash": "b00dd879",
    "kind": "prepare-alarm",
    "station": "건대입구",
    "meta": "{\"outcome\":\"skipped\",\"reason\":\"not-preceding\"}"
  },
  {
    "id": 1984,
    "ts": 1793616585214,
    "token_hash": "b00dd879",
    "kind": "prepare-alarm",
    "station": "어린이대공원(세종대)",
    "meta": "{\"outcome\":\"skipped\",\"reason\":\"no-lock\"}"
  },
  {
    "id": 2022,
    "ts": 1793617245180,
    "token_hash": "b00dd879",
    "kind": "prepare-alarm",
    "station": "중곡",
    "meta": "{\"outcome\":\"fired\",\"targetStation\":\"용마산\",\"targetKind\":\"destination\",\"pushId\":\"25db95df-4e00-4e2f-8cc9-8fc2127a5ff5\"}"
  },
  {
    "id": 2035,
    "ts": 1793617378552,
    "token_hash": "b00dd879",
    "kind": "trip-end",
    "station": "7-015",
    "meta": "{\"reason\":\"destination-arrived\",\"endPath\":\"lock-active-destination\"}"
  },
  {
    "id": 2038,
    "ts": 1793617398419,
    "token_hash": "b00dd879",
    "kind": "trip-end",
    "station": "7-015",
    "meta": "{\"reason\":\"arrival-auto-clear\",\"endPath\":\"http-delete\"}"
  }
];
