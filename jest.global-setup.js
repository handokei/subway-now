// #3366 — 시각 표기(toLocaleTimeString/getHours)가 로컬 TZ에 의존하는 덤프 characterization을
// 로컬(KST)·CI(ubuntu UTC) 어디서나 동일하게 만들기 위해 테스트 프로세스 TZ를 UTC로 고정한다.
// (jest 샌드박스 안에서의 `process.env.TZ = ...` 대입은 Date에 반영되지 않음 — 실측 확인.
//  globalSetup은 워커 fork 이전 부모 프로세스에서 실행되므로 워커가 상속한다.)
module.exports = async () => {
  process.env.TZ = 'UTC';
};
