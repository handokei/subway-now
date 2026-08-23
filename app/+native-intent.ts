// 위젯 딥링크 alias — 라우터 마운트 전에 경로 재작성해 중간 리다이렉트 라우트를 제거한다.
// subwaynow://current-station → 홈 탭 직행 (흰 화면·push 슬라이드 없음).
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  if (path === 'current-station' || path.endsWith('/current-station')) return '/';
  return path;
}
