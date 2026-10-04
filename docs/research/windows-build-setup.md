# 연구 노트: 이 PC(Windows 11)에서 AgentCraft 빌드 환경 구성

- 작성일: 2026-10-04
- 상태: 결론 도출 (미해결 2건)
- 관련: mod/DEV.md, tools/README.md, foreman/README.md, 로컬 `dev-env.ps1` (git 미추적)

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
