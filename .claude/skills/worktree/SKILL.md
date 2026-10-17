---
name: worktree
description: "git worktree로 이슈별 격리 작업 환경 생성/관리. '워크트리 만들어줘', 'wt new', '새 작업 격리', '이슈 격리', '워크트리 정리', '워크트리 목록' 요청 시 트리거."
allowed-tools: Bash
argument-hint: "[new <이슈번호> <타입> <기능명> | list | clean <이슈번호>]"
---

## 목적

이슈별로 완전히 격리된 git worktree를 생성해 병렬 작업 시 파일 충돌을 방지한다.
각 이슈는 독립된 디렉토리에서 작업하므로 테스트/파일 수정이 서로 영향을 주지 않는다.

## 트리거 조건

- "워크트리 만들어줘", "wt new", "새 작업 격리", "이슈 격리"
- "워크트리 목록", "wt list"
- "워크트리 정리", "wt clean"

## 핵심 룰 (필수)

### node_modules는 반드시 실제 `npm install` (symlink 금지)

워크트리 생성 시 시간 절약을 이유로 `ln -s ../subway-now/node_modules node_modules` 패턴을
**절대 사용하지 않는다.** 본 프로젝트는 로컬 expo modules(`modules/live-activity`,
`modules/audio-route`, `modules/motion-activity`, `modules/wifi-ssid`)를 다음과 같이 상대
심링크로 등록한다:

```
node_modules/live-activity → ../modules/live-activity
```

워크트리에서 `node_modules`를 메인 repo로 심링크하면 위 상대 경로가 **메인 repo의 modules/**로
해석되고, 워크트리 소스의 `jest.mock('../../../../../modules/live-activity', ...)`은 워크트리
경로로 resolve된다. Jest는 mock을 absolute path 키로 보관하므로 두 경로가 달라지면 mock이
적용되지 않아 **광역 테스트 false positive**(이슈 #1090: 35건 실패)가 발생한다.

따라서 워크트리 생성 시 **항상** 다음을 자동 실행한다:

```bash
npm install --prefer-offline --no-audit --no-fund
```

(`npm ci`는 `package-lock.json` 외 로컬 expo modules 링크를 새로 만들지 않을 수 있어 사용하지 않는다.)

### 검증

생성 후 다음 명령으로 실제 install 여부와 mock-resolve 안전성을 확인한다:

```bash
# 1. node_modules가 심링크가 아닌 실제 디렉토리인지
test -L node_modules && echo "FAIL: symlink" || echo "OK: real dir"

# 2. live-activity가 워크트리 내부 경로로 resolve 되는지
node -e "console.log(require.resolve('live-activity'))"
# 결과가 워크트리 디렉토리 안 경로여야 함 (메인 repo 경로면 FAIL)
```

위 둘 중 하나라도 실패하면 `rm -rf node_modules && npm install --prefer-offline --no-audit --no-fund`로 복구한다.

## 절차

### 요청 유형 판단

사용자 요청에서 의도를 파악:
- 생성 요청 → **[생성]** 절차
- 목록 확인 → **[목록]** 절차
- 정리 요청 → **[정리]** 절차

---

### [생성] 새 워크트리 만들기

**1단계: 인자 확인**

이슈번호, 타입, 기능명이 제공되지 않은 경우 질문:
- 이슈번호: GitHub 이슈 번호 (예: 68)
- 타입: `feat` | `fix` | `chore` | `refactor`
- 기능명: 브랜치 이름에 쓸 영문 kebab-case (예: widget-destination)

**2단계: 워크트리 생성 + 자동 install**

```bash
bash .claude/skills/worktree/scripts/wt-new.sh <이슈번호> <타입> <기능명>
```

이 스크립트는 다음을 순차 실행한다:
1. `git fetch origin`
2. `git worktree add ... -b <branch> origin/dev`
3. **새 워크트리에서 `npm install --prefer-offline --no-audit --no-fund`** (symlink 금지 룰 강제)
4. 검증: `node_modules`가 심링크가 아닌지, `live-activity`가 워크트리 내부로 resolve 되는지

install 실패 시 워크트리 자체는 유지하되 명확히 보고한다(사용자가 재시도 가능).

**3단계: 결과 안내**

```
✅ 워크트리 생성 완료
브랜치: <타입>/#<이슈번호>-<기능명>
경로:   ../subway-now-issue<이슈번호>
node_modules: real install (npm install 완료)

새 터미널에서:
  cd ../subway-now-issue<이슈번호> && claude
```

---

### [목록] 워크트리 확인

```bash
bash .claude/skills/worktree/scripts/wt-list.sh
```

현재 활성 워크트리 목록과 각 브랜치를 출력한다.

---

### [정리] 워크트리 제거

**1단계: 이슈번호 확인**

제공되지 않은 경우 현재 목록을 보여주고 질문.

**2단계: 워크트리 제거**

```bash
bash .claude/skills/worktree/scripts/wt-clean.sh <이슈번호>
```

## 자체 검증

- [ ] 이슈번호/타입/기능명이 모두 확인되었는가
- [ ] 브랜치명이 `<타입>/#<이슈번호>-<기능명>` 형식인가
- [ ] origin/dev 기준으로 생성되었는가
- [ ] **`npm install` 자동 실행되어 `node_modules`가 실제 디렉토리인가 (symlink 아님)**
- [ ] **`require.resolve('live-activity')`가 워크트리 내부 경로를 반환하는가**
- [ ] 생성 경로가 올바르게 안내되었는가

## 관련 이슈/메모

- 이슈 #1090 — 워크트리 symlink로 jest 35건 false positive
- 메모: `feedback_worktree_for_isolation.md` — "node_modules는 symlink 말고 실제 install"
