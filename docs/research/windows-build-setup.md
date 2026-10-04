# 연구 노트: 이 PC(Windows 11)에서 AgentCraft 빌드 환경 구성

- 작성일: 2026-10-04
- 상태: 결론 도출 (미해결 2건)
- 관련: mod/DEV.md, tools/README.md, foreman/README.md, `dev-env.ps1`, `run-codex.ps1` (리포 루트, 2026-10-04부터 커밋)

## 질문
clean checkout(main @ 0be815d) 상태에서 mod(Fabric, MC 26.3), foreman(Node/TS), assets 동기화 검사를
이 PC에서 빌드/테스트 통과시키려면 무엇이 필요한가.

## 결론 (먼저 쓴다)
1. **JDK 25 필요** (시스템 기본은 Zulu 17). 포터블 Temurin 25.0.4.1+1을 `%USERPROFILE%\.jdks\`에 설치, 시스템 Java/PATH는 건드리지 않음.
2. **`%LOCALAPPDATA%\Temp` 하위에서 AF_UNIX `connect()`가 `WSAEINVAL`로 실패** → 모든 JVM의 NIO `Selector.open()`이
   `Unable to establish loopback connection`으로 죽음 (Gradle 데몬 접속 불가, JDK 17/25 동일). TEMP/TMP를 Temp 밖 경로로 돌리면 해결.
3. 빌드 전 `. .\dev-env.ps1` 실행 (JAVA_HOME, GRADLE_USER_HOME=`<repo>\.gradle-home`, TEMP=`%USERPROFILE%\.agentcraft-tmp` 설정).
4. 결과: `gradlew build` 성공 (`mod/build/libs/agentcraft-0.1.0.jar`), `sync.py --check` 최신, `launch.ps1 -DryRun` 통과,
   foreman 테스트 481/482 통과. 남은 1건은 Node 26 호환성 버그 → 2026-10-04 수정 후 485/485.

5. 2026-10-04 추가: 원샷 스크립트 `run-codex.ps1` (처음엔 미추적, 사용자 요청으로 `dev-env.ps1`과 함께 커밋). 도구 확인 → JDK 25(없으면 Temurin 포터블 설치, SHA-256 검증)
   → 위 환경변수 → 대상 리포(기본 `sandbox/codex-demo` 자동 생성) → Foreman만 기동 → 로그에서 장치 코드 표시/클립보드/브라우저 → 로그인 완료 후 게임 기동.
   주의: launch.ps1을 `-File`로 부르면 `-ForemanArgs` 배열이 쉼표로 합쳐져 Foreman이 거부함 → `-Command` + 인자별 작은따옴표 인용으로 호출.
6. 2026-10-04 추가: `run-deepseek.ps1` (프로필 `deepseek`, claude 런타임). 키는 `Read-Host -AsSecureString` → `foremancli connection-setup --key-stdin`의
   stdin으로만 전달(명령줄 인자 금지: 다른 프로세스가 볼 수 있음). 저장된 연결이 동작하면 재입력 없이 재사용, 거절되면 최대 3회 재입력.
   첫 등록 시 "코드가 DeepSeek으로 전송" 확인(-Yes로 생략). `-ApiKeyEnv NAME`이면 env 참조로 저장.
   실측: 가짜 키(env, stdin 둘 다) → 실제 DeepSeek 401 → 실패 사유 출력, 로그/파일에 키 없음.
   **함정:** Windows PowerShell 5.1은 네이티브 명령 인자 안의 큰따옴표를 제거함 → `node -p 'process.versions.node.split(".")[0]'`가 SyntaxError.
   run-codex.ps1에도 있던 버그(PS7에서만 테스트해서 놓침). 바깥 큰따옴표 + 안쪽 작은따옴표로 수정. 스크립트는 PS 5.1과 7 둘 다로 검증할 것.
7. 2026-10-04 사용자 실행 실패: `run-deepseek.ps1`이 포트 7878 충돌로 중단 — 이미 `run-codex.ps1`로 띄운 codex Foreman이 실행 중이었음.
   포트만 바꾸면 안 되는 이유: 체크아웃당 게임 1개이고, 재사용된 게임은 원래 Foreman 포트에 붙어 있음(launch.ps1은 경고만).
   수정: 시작 전 `<home>/<profile>/foreman.json`(pid 살아 있는 node)로 다른 프로필 Foreman 감지 → `-IfRunning ask|stop|use|cancel`(기본 ask:
   [S]top 권장 = stop.ps1로 그 게임·Foreman 정상 종료 후 진행 / [U]se = 그 Foreman에 DeepSeek 연결을 추가·배정 / [C]ancel).
   use 경로에서 발견한 결함: `-ApiKeyEnv`의 env 참조는 이미 떠 있는 Foreman 환경엔 없음 → 이 경우 스크립트가 값을 읽어 stdin으로 넘기고 자격증명 저장소에 저장.
   격리 홈·포트 27878에서 stop/use/cancel 세 경로 모두 실측(가짜 키는 실제 DeepSeek 401). 실패한 첫 use 테스트는 테스트 명령의 경합
   (Foreman이 foreman.json을 쓰기 전에 스크립트 실행)이었음 — 스크립트 결함 아님.
8. 2026-10-04 사용자 실행 실패 2: [S]top 선택 → stop.ps1이 "Foreman 'codex' already stopped"라며 실행 기록을 지웠는데 pid 8616은 살아서 포트 점유.
   원인(재현 확인): 기존 `tools/lib/procs.ps1`의 `Test-SameProc([string]$Start)`. **PowerShell 7의 ConvertFrom-Json은 ISO 날짜를 DateTime으로 변환**하고,
   `[string]` 캐스트가 `Z`를 버려 `10/04/2026 07:48:01` → `DateTime.Parse`가 로컬(KST)로 해석 → 9시간 차 → "다른 프로세스"로 오판.
   PS 5.1은 문자열 그대로라 정상. launch.ps1/stop.ps1은 5.1 기준이었고, run-*.ps1이 자식 스크립트를 현재 셸(PS7)로 실행해 드러남.
   수정: `ConvertTo-UtcTime`(DateTime이면 Kind 보존, 문자열은 InvariantCulture+RoundtripKind) + 시작시각 인자를 [object]로(Test-SameProc/Wait-ProcExit/Stop-OwnTree, stop.ps1:129).
   PS7·5.1 양쪽에서 같은 pid true / 다른 시각 false 확인. 지워진 codex 실행 기록은 bg 상태 파일 + 실제 프로세스 시작시각으로 복원
   (`artifacts/run/foreman-codex-restored.json`). run-deepseek.ps1은 stop 후 pid가 실제로 사라졌는지 확인하도록 보강.
9. 2026-10-04 "창 모드가 안 됨": 설정은 `fullscreen:false`였지만 게임 창이 `build.gradle`에서 1920x1080 고정.
   이 PC는 1920x1080 모니터(작업 영역 1920x1032, 배율 100%) → 창+제목줄+테두리가 화면보다 커서 전체 화면처럼 보이고 제목줄을 잡을 수 없음.
   수정: build.gradle이 `AGENTCRAFT_WINDOW_WIDTH/HEIGHT`를 읽고, `launch.ps1 -Window WxH|auto`(기본 auto)가 주 모니터 작업 영역에 맞는 최대 16:9 크기를 계산
   (여유: 가로 16, 세로 40). `-Dev`는 스크린샷 QA가 1920x1080 프레임버퍼를 전제하므로 1920x1080 유지. run-codex/run-deepseek에 `-Window` 전달.
   실측: auto → 1760x990, 실제 게임 창 1760x990 확인(dev.state). 한계: 배율 100%에서만 확인 — 배율이 다른 모니터에서 SDL3 창 크기 단위(논리/물리) 미검증.

## 환경
- OS: Windows 11 Pro 10.0.26200, 비관리자 셸
- 도구: git 2.53.0, Node v26.7.0 / npm 11.19.0, Python 3.12 (+ py launcher), Zulu JDK 17.0.19(시스템 기본), Temurin JDK 25.0.4.1+1(포터블, 신규)
- Gradle 9.7.1 (wrapper), Loom 1.18.2, Fabric Loader 0.19.5, Fabric API 0.161.0+26.3
- Blender 미설치 (assets `--sheets` 렌더에만 필요, 빌드엔 불필요)

## 실험 및 관찰
### 실험 1: Gradle 빌드 (JDK 25, 기본 TEMP)
- 절차: `JAVA_HOME=<jdk25>; GRADLE_USER_HOME=<repo>\.gradle-home; mod\gradlew.bat build` (샌드박스 유무 무관)
- 결과: `java.io.IOException: Unable to establish loopback connection` (DefaultDaemonConnector.connectToDaemon)
- 해석: 데몬은 떴지만 클라이언트 쪽 NIO Selector 생성 단계에서 실패.

### 실험 2: 최소 재현 (`Selector.open()`, `Pipe.open()`)
- JDK 25, JDK 17 모두 실패. Caused by `java.net.SocketException: Invalid argument: connect` at `UnixDomainSockets.connect0`.
- `afunix` 커널 드라이버는 RUNNING.
- `-Djdk.net.unixdomain.tmpdir=<repo 하위>` → 성공. `=C:\Users\kernullist\AppData\Local\Temp`(긴 경로) → 실패.
- `TEMP=%LOCALAPPDATA%\Temp\agentcraft`(하위 폴더) → 실패. `TEMP=C:\Temp\x`, `TEMP=%USERPROFILE%\.agentcraft-tmp` → 성공.
- 해석: 8.3 단축 경로 문제가 아니라 **Temp 트리 자체**에서 AF_UNIX 소켓 파일(IO_REPARSE_TAG_AF_UNIX) 처리가 깨짐.
  Temp에 남은 `socket_*` 파일은 `fsutil reparsepoint query/delete`, `rmdir` 모두 `Error 1920: The file cannot be accessed by the system`.
  Temp에 이런 잔여 `socket_*`가 이미 36개 존재 → 이전부터 모든 JVM이 이 문제를 겪고 있었음.
  Controlled Folder Access는 꺼져 있음. `fltmc`는 비관리자라 확인 불가 → 미니필터(보안 제품/자체 드라이버) 의심.

### 실험 3: foreman `npm run check`
- 기본 TEMP(`C:\Users\KERNUL~1\...`): 2건 실패
  - `claude-backend.test.ts`: realpath 비교에서 `KERNUL~1` vs `kernullist` 불일치 → TEMP를 긴 경로로 바꾸면 통과(환경 문제).
  - `repos.test.ts > runs the repo test command`: `res.summary` undefined.
- 원인(두 번째): `foreman/src/repos.ts` `parseTestOutput()`은 TAP의 `# tests N` 줄만 파싱. Node 23+ 의 `node --test` 기본 리포터는
  비TTY에서도 spec(`ℹ tests N`)이라 summary가 안 나옴. README의 "Node 22+" 보장과 충돌하는 **제품 버그**.

## 반증 / 실패한 시도
- `dangerouslyDisableSandbox`로 실행: 무관 (Claude Code 샌드박스 원인이 아님).
- TEMP를 Temp 하위 폴더로 옮기기: 실패 (Temp 트리 전체가 영향).
- TEMP를 리포 내부(`.gradle-home\tmp`)로: Java는 되지만 foreman `repos.test.ts`가 "inside the git repository"로 추가 실패. 리포 밖이어야 함.
- `JAVA_TOOL_OPTIONS=-Djdk.net.unixdomain.tmpdir=...` 전역 설정: 채택 안 함. "Picked up ..." 배너가 stderr 첫 줄에 찍혀
  `tools/launch.ps1:156`의 `java -version` 첫 줄 파싱이 깨짐.

## 레퍼런스
- `tools/launch.ps1:153-158` Java 25 검사 로직 (JAVA_HOME 우선)
- `foreman/src/repos.ts:66` `parseTestOutput`, `foreman/test/repos.test.ts:254`
- JDK `sun.nio.ch.PipeImpl` (Windows: JDK 16+ 에서 Selector wakeup pipe를 AF_UNIX로 구성, 소켓 파일 위치 = `jdk.net.unixdomain.tmpdir` 또는 TEMP)

## 미해결
- [ ] Temp 트리에서 AF_UNIX가 깨지는 근본 원인: 관리자 권한으로 `fltmc instances -v C:` 확인, 보안 제품/자체 미니필터의 Temp 경로 정책 점검. 잔여 `socket_*` 정리도 그 이후.
- [x] 2026-10-04 `parseTestOutput` spec 리포터 지원 추가 (`ℹ tests/pass/fail N`, `✖ failing tests:` 섹션의 leaf 실패만, `(N ms)` 접미사 제거, CRLF 허용).
  TAP/spec 픽스처 단위 테스트 3건 추가. `npm run check` 485/485 통과.
- [ ] `runClient` 실제 실행(게임 기동) 미검증. 첫 실행 시 Minecraft 에셋 다운로드 수 분 소요.
