// 한글 자모 분해 테이블 (유니코드 한글 음절 = 0xAC00 + (초성*21 + 중성)*28 + 종성).
// 역 검색 퍼지 매칭(fuzzyStationSearch)이 음절 오타·IME 조합 중 입력을 자모 단위로 흡수하는 데 쓴다.

export const HANGUL_SYLLABLE_BASE = 0xac00;
export const HANGUL_SYLLABLE_LAST = 0xd7a3;
export const HANGUL_JUNG_COUNT = 21;
export const HANGUL_JONG_COUNT = 28;

export const CHOSEONG = [...'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ'];
export const JUNGSEONG = [...'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ'];
// 인덱스 0 = 받침 없음
export const JONGSEONG = ['', ...'ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ'];

// 복합 모음·겹받침은 기본 자모 시퀀스로 풀어 "호ㅓ" 같은 조합 중 입력이 "화"와 가깝게 비교되도록 한다.
export const JAMO_EXPANSION: Readonly<Record<string, string>> = {
  ㅘ: 'ㅗㅏ',
  ㅙ: 'ㅗㅐ',
  ㅚ: 'ㅗㅣ',
  ㅝ: 'ㅜㅓ',
  ㅞ: 'ㅜㅔ',
  ㅟ: 'ㅜㅣ',
  ㅢ: 'ㅡㅣ',
  ㄳ: 'ㄱㅅ',
  ㄵ: 'ㄴㅈ',
  ㄶ: 'ㄴㅎ',
  ㄺ: 'ㄹㄱ',
  ㄻ: 'ㄹㅁ',
  ㄼ: 'ㄹㅂ',
  ㄽ: 'ㄹㅅ',
  ㄾ: 'ㄹㅌ',
  ㄿ: 'ㄹㅍ',
  ㅀ: 'ㄹㅎ',
  ㅄ: 'ㅂㅅ',
};

// 호환 자모(ㄱ~ㅣ) 또는 한글 음절이 하나라도 있으면 한글 쿼리로 본다 (영문 쿼리는 퍼지 대상 아님).
export const HANGUL_PATTERN = /[ㄱ-ㅣ가-힣]/;

// 자모 편집거리 허용치 = floor(쿼리 자모 수 / 4). 짧은 쿼리일수록 엄격해 엉뚱한 역 노출을 막는다.
export const FUZZY_JAMO_PER_EDIT = 4;
