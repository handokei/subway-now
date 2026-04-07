// expo 모듈이 import.meta를 사용하는 부분을 Jest 환경에서 모킹
global.__ExpoImportMetaRegistry = {};

// node 환경에서 누락된 타이머 함수 보완
if (typeof clearInterval === 'undefined') {
  global.clearInterval = () => {};
}
if (typeof setInterval === 'undefined') {
  global.setInterval = () => 0;
}
