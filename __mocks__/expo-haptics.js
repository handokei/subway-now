// expo-haptics 수동 mock — 네이티브 모듈로 jest transform 미지원.
// jest.mock('expo-haptics') 호출 없이도 해당 모듈을 import하는 파일이 동작하도록 한다.
// 개별 테스트가 spy를 주입하려면 jest.mock('expo-haptics', factory) 로 덮어쓴다.
module.exports = {
  impactAsync: jest.fn().mockResolvedValue(undefined),
  notificationAsync: jest.fn().mockResolvedValue(undefined),
  selectionAsync: jest.fn().mockResolvedValue(undefined),
  ImpactFeedbackStyle: { Light: 'Light', Medium: 'Medium', Heavy: 'Heavy' },
  NotificationFeedbackType: { Success: 'Success', Warning: 'Warning', Error: 'Error' },
};
