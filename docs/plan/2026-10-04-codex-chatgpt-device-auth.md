# 작업 계획서: ChatGPT 구독(장치 인증)으로 에이전트 팀을 돌리는 `codex` 백엔드

- 작성일: 2026-10-04
- 상태: 진행중 — 구현 완료, 실기 검증 대기 (2026-10-04 승인, main에서 직접 진행)
- 관련 문서: [[docs/research/windows-build-setup.md]], foreman/README.md, foreman/src/agents/claude/*

## 1. 목표 / 배경
- 현재 Foreman의 실제 LLM 백엔드는 `claude` 하나뿐이고, Claude Agent SDK에 강하게 묶여 있음
  (`query()` 스트림, `canUseTool` 권한 게이트, in-process MCP 도구, 세션 resume).
- 목표: **ChatGPT 구독(Plus/Pro/Team 등)을 장치 인증(device code)으로 로그인**해서 같은 팀(리드 + 워커),
  같은 안전장치(worktree, 인게임 권한 프롬프트, push 차단, 사용자 승인 merge)로 돌리는 `--backend codex` 추가.
- 장치 인증을 쓰는 이유: 게임/헤드리스 환경에서 브라우저 콜백(localhost redirect) 없이 다른 기기에서도
  URL + 코드로 로그인 가능. 인게임 배너에 코드를 띄우면 UX가 자연스러움.

### 사전 조사 결과 (2026-10-04, 이 PC)
- `codex-cli 0.147.0` 설치됨, `codex login status` = "Logged in using ChatGPT".
- `codex app-server`(stdio JSON-RPC, IDE 확장이 쓰는 공식 프로토콜)를 `generate-ts`로 바인딩 생성해 확인:
  - `account/login/start {type:"chatgptDeviceCode"}` → `{loginId, verificationUrl, userCode}`, 완료는 `account/login/completed` 알림. `account/read`로 상태/플랜 조회.
  - `thread/start|resume`, `turn/start|interrupt|steer`, 스트림 알림 `item/started|completed`, `item/agentMessage/delta`, `item/commandExecution/outputDelta`, `item/fileChange/patchUpdated` 등.
  - 서버→클라이언트 요청: `item/commandExecution/requestApproval`, `item/fileChange/requestApproval` (응답 `accept|acceptForSession|decline|cancel`).
  - **dynamic tools**: `thread/start {dynamicTools:[...]}` + 서버→클라이언트 `item/tool/call` → 클라이언트가 실행 후 결과 반환.
    단 **experimental API** (`initialize` 시 `capabilities.experimentalApi: true` 필요).

## 2. 범위
- 포함:
  1. `--backend codex` (+ env `AGENTCRAFT_BACKEND=codex`, config.json `codex.*`).
  2. 장치 인증 로그인: Foreman이 app-server로 device code 로그인을 시작하고 URL/코드를 콘솔 + 인게임 배너 + 데스크톱 알림으로 표시, 완료 시 자동 진행.
  3. Codex 턴 실행기: 스레드 생성/재개, 스트림 → agent.log/상태 매핑, 승인 요청 → 기존 `policy.ts` 분류 + 인게임 권한 decision.
  4. 팀 도구(ask_user, message, task 보고, memory 등)를 dynamic tools로 제공.
  5. Claude 백엔드의 오케스트레이션(잡 큐, 스케줄링, CI, 리뷰, 핸드오프, pause/stop, recover)을 공통 계층으로 추출해 두 백엔드가 공유.
  6. 프로토콜 `BackendName`에 `codex` 추가 (foreman zod + mod `Protocol.java`), `docs/protocol.md` 재생성.
  7. `tools/launch.ps1` `-Backend codex` 허용, README/foreman README 문서화.
- 제외(이번에 안 함):
  - AgentCraft가 OpenAI OAuth를 **직접 구현**하거나 토큰을 읽고/저장/전달하는 것 (아래 3절 C안 기각 사유).
  - OpenAI API 키 / Bedrock 등 다른 Codex 인증 모드의 UI (app-server가 지원하므로 후속으로 쉽게 추가 가능, 이번엔 ChatGPT 장치 인증만).
  - lead=Claude, worker=Codex 같은 혼합 팀.
  - macOS 런처(`tools/mac.mjs`) 변경은 플래그 통과만, 실기 검증은 안 함.
- 전제 조건 / 의존성:
  - 사용자 PC에 공식 Codex CLI 설치 (`npm i -g @openai/codex`), 최소 버전은 구현 시 확정해 시작 시 검사.
  - app-server experimental API(dynamic tools)의 안정성.

## 3. 접근안 비교

### 3-1. Codex를 어떻게 구동하나
| 안 | 요약 | 장점 | 단점 | 리스크 |
|---|---|---|---|---|
| A | `codex app-server` (stdio JSON-RPC) | 장치 인증/승인 요청/dynamic tools/resume/interrupt 전부 공식 지원. IDE 확장과 같은 경로 | 프로토콜 클라이언트 직접 구현 (~400줄). dynamic tools는 experimental | CLI 버전업 시 프로토콜 변화 |
| B | `@openai/codex-sdk` (`codex exec` JSONL 래퍼) | 가장 간단, 공식 SDK | **승인 콜백 없음** → 인게임 권한 프롬프트 불가 (approval=never + sandbox 의존). 커스텀 도구는 MCP 서버 별도 필요. 장치 로그인 API 없음 | 핵심 안전장치(사용자 승인) 상실 |
| C | AgentCraft가 OpenAI OAuth device flow 직접 구현 후 Responses API 호출 | 의존성 최소 | Codex의 client_id를 쓰면 **공식 클라이언트 사칭**, 토큰 저장/갱신 책임, 에이전트 루프/도구/샌드박스 전부 자체 구현 | 약관 위반 소지, 보안 책임 큼 |

**선택: A (app-server)**
- B는 사용자 승인 없는 실행이 되어 README의 "Risky commands ask first" 보장을 깨므로 기각.
- C는 토큰을 AgentCraft가 다루게 되고 공식 클라이언트 사칭 문제가 있어 기각. A는 인증을 **공식 Codex가 소유**하고 AgentCraft는 URL/코드만 중계 → `--use-claude-login`과 같은 원칙(자기 로그인, 공식 CLI 경유).

### 3-2. 팀 도구 제공 방식
| 안 | 요약 | 장점 | 단점 |
|---|---|---|---|
| A | dynamic tools (`item/tool/call`) | in-process, 턴/에이전트 바인딩이 자연스러움 (현재 SDK MCP와 동일 구조) | experimental |
| B | Foreman이 127.0.0.1 streamable-HTTP MCP 엔드포인트 제공, `mcp_servers` config로 연결 | 안정 API | 포트/토큰/턴 바인딩 추가 구현, 로컬 포트 노출 |

**선택: A**, 단 도구 정의를 전송 계층과 분리해서 B로 교체 가능하게 둔다 (experimental 깨질 때 대비).

### 3-3. 오케스트레이션 공유
| 안 | 요약 | 장점 | 단점 |
|---|---|---|---|
| A | `ClaudeBackend` 복붙 후 `CodexBackend` | 기존 코드 무변경 | ~800줄 중복, 버그 수정 이중화 |
| B | 공통 `TeamBackend`(잡 큐/스케줄/CI/리뷰/steering/recover) + `TurnRunner` 인터페이스(Claude/Codex) | 중복 제거, 세 번째 백엔드도 쉬움 | 기존 claude 경로 리팩터링 회귀 위험 |

**선택: B.** 기존 claude 테스트(fake SDK, `queryFn` 주입)가 회귀 방지망. 리팩터링은 **동작 변경 없는 별도 커밋**으로 먼저 하고 전체 테스트 통과 확인 후 Codex 추가.

### 3-4. Codex 상태 디렉터리
| 안 | 요약 | 장점 | 단점 |
|---|---|---|---|
| A | 전용 `CODEX_HOME = <home>/<profile>/codex` | 사용자 `~/.codex/config.toml`(개인 MCP 서버, AGENTS.md, 프로필)이 에이전트 턴에 섞이지 않음 (Claude의 `settingSources: []`와 같은 격리). 장치 인증 1회로 영구 | 이미 로그인돼 있어도 1회 재로그인 필요 |
| B | 사용자 기본 `~/.codex` | 재로그인 불필요 | 개인 설정 누출, 격리 깨짐 |

**선택: A 기본**, `--codex-home <dir>`로 B도 허용.

## 4. 구현 단계
1. **리팩터링 (동작 무변경)**: `agents/claude/index.ts`에서 오케스트레이션을 `agents/team/backend.ts`로 추출, Claude 고유 부분(`query()` 옵션, canUseTool 어댑터, StreamMapper, auth)은 `ClaudeRunner`로. `tools.ts`의 도구 정의를 SDK 비의존 스펙(`name, description, zod schema, handler`)으로 분리하고 Claude는 `createSdkMcpServer` 어댑터로 감쌈. → `npm run check` 전부 통과 후 커밋.
2. **app-server 클라이언트** `agents/codex/appserver.ts`: 프로세스 spawn(`windowsHide`, pid 추적, 기존 `killTree` 재사용), JSON-RPC 요청/응답 매칭, 알림 구독, 서버 요청 핸들러, `initialize{experimentalApi:true}`, 크래시/EOF 시 대기 중 요청 전부 reject.
3. **인증** `agents/codex/auth.ts`: 시작 시 `account/read` → 로그인 안 됨이면 `account/login/start{chatgptDeviceCode}` → `foreman.status{auth:'checking', message:"Sign in to ChatGPT: <url> code <CODE>"}` + 콘솔 + 알림, `account/login/completed` 대기(만료/취소 시 `failed`), 성공 시 `account` = 이메일·플랜. API 키 모드는 막음(ChatGPT 구독만이 이번 범위).
4. **CodexRunner** `agents/codex/runner.ts`: 잡 → `thread/start`(최초) 또는 `thread/resume`(세션 키에 threadId 저장), `cwd` = worktree/리포, `sandbox` = 리드 `read-only` / 워커 `workspace-write`, `approvalPolicy` = 정책 게이트가 모든 비안전 명령을 보도록 설정, `developerInstructions` = 기존 lead/worker 시스템 프롬프트, `dynamicTools` = 팀 도구, 모델/effort 매핑, `turn/start` 후 `turn/completed`까지 스트림 처리, abort 시 `turn/interrupt` + 프로세스 트리 종료.
5. **스트림 매핑** `agents/codex/stream.ts`: `ThreadItem` 종류(agentMessage, reasoning, commandExecution, fileChange, dynamic tool call) → 기존 `fm.agentLog` 종류(text/tool/result/error)와 `activity.ts`의 상태/스테이션. 토큰 사용량 → spend 표시(구독이므로 USD 대신 토큰/한도 표시, `account/rateLimits/updated` 활용).
6. **승인 매핑**: `commandExecution/requestApproval` → `classifyToolUse('Bash', {command}, ...)`, `fileChange/requestApproval` → 변경 파일별 `Edit/Write` 분류. allow → `accept`, deny → `decline`, ask → 기존 인게임 permission decision → 응답. "Always allow"는 기존 `permissionRules` 재사용(Codex의 `acceptForSession`/execpolicy amendment는 쓰지 않음: 규칙의 진실원은 Foreman).
7. **git 안전장치**: app-server 프로세스 env에 `withGitSafety`/`agentEnv`(에이전트 git identity, transport 차단) 적용, `shell_environment_policy.inherit="all"`을 config override로 명시해 명령까지 전달되는지 테스트로 고정. 추가로 sandbox network 차단.
8. **설정/프로토콜/런처**: `config.ts`에 `CodexConfig`(model, leadModel, workerModel, effort, codexHome, codexBin), HELP, `protocol.ts` `BackendName`에 `codex`, mod `Protocol.java` enum + 배너 문구, `docs/protocol.md` 재생성, `launch.ps1` ValidateSet, `notify` 기본값 codex도 on.
9. **문서**: README(Quick start에 ChatGPT 구독 경로), foreman/README, ADR 0001(백엔드 추상화 + app-server 선택), CHANGELOG.

## 5. 위험 및 실패 경로
- **dynamic tools experimental 변경/제거**: 증상 = thread/start 에러 또는 `item/tool/call` 미수신. 완화 = 시작 시 버전 검사 + 도구 스펙 분리로 3-2 B안(HTTP MCP) 교체.
- **프로토콜 드리프트**: CLI 업데이트로 필드명 변경. 완화 = 최소/검증 버전 고정 검사, 미지 알림은 무시+debug 로그, fake app-server로 계약 테스트.
- **Windows 샌드박스**: Codex의 Windows 샌드박스 지원 수준에 따라 `workspace-write`가 약하거나 무시될 수 있음. 그 경우에도 승인 게이트 + git transport 차단은 유지되지만, worktree 밖 쓰기 방지는 Foreman 정책에만 의존. 탐지 = 통합 테스트에서 worktree 밖 쓰기 시도가 승인 요청으로 오는지 확인. 실패 시 Windows에서는 `approvalPolicy`를 더 엄격하게(모든 명령 승인 요청) 강제.
- **승인 우회**: Codex가 "안전"으로 판단해 승인 없이 실행하는 명령(읽기 계열)이 존재. 쓰기/네트워크는 sandbox가 막아야 함 → 위 Windows 리스크와 연결. 검증 항목으로 명시.
- **git push 우회**: env가 명령까지 전달 안 되면 push 차단이 깨짐(최우선 보장). 탐지 = "명령 안에서 `git push` 실패" 통합 테스트. 실패 시 codex 백엔드 시작 거부.
- **장치 로그인 만료/취소/네트워크 오류**: `failed` 배너 + 재시도 안내(`/login` 콘솔 명령 또는 Foreman 재시작).
- **구독 한도 소진(rate limit)**: 턴 실패 → 기존 retryLater 경로, 배너에 한도/리셋 시각 표시.
- **리팩터링 회귀**: claude 경로 동작 변화. 탐지 = 기존 482(+3) 테스트, 특히 claude-* 테스트. 1단계를 별도 커밋으로 격리.
- **약관**: ChatGPT 구독을 공식 Codex 클라이언트로 본인 PC에서 쓰는 형태이고 AgentCraft는 토큰을 만지지 않음. 그래도 서드파티 오케스트레이션 사용 범위는 OpenAI 정책 확인 필요(오픈 이슈). 문서에 "personal use" 문구는 Claude 쪽과 일관되게.
- **호환성**: Node 22+/Windows 10·11/macOS, Codex CLI 버전, 기존 mod(구버전 mod는 `codex`를 UNKNOWN으로 표시, 동작은 됨).

## 6. 검증 방법
- 단위/계약 테스트 (vitest, API 호출 없음):
  - fake app-server(스크립트된 JSON-RPC 상대)로: 장치 로그인 흐름(시작→코드 표시→완료/만료), 턴 실행 → 로그/상태 매핑, 승인 요청 allow/deny/ask→decision 응답, dynamic tool call → 팀 도구 실행/결과, interrupt/pause/stop, resume(threadId 재사용), app-server 크래시 처리.
  - 정책 매핑: 명령/파일 변경 → `classifyToolUse` 결과 테이블.
  - git 안전장치: 실제 `codex`가 아니라도 env 전달 경로를 fake에서 검증 + (옵션) 실기 테스트.
- 실기 검증 (이 PC, ChatGPT 구독):
  1. 전용 CODEX_HOME에서 장치 로그인 → 인게임 배너에 URL/코드 표시 → 완료 후 `auth ok` + 플랜 표시.
  2. sim 데모 리포에 작은 goal → 리드 계획 → 워커 worktree 편집 → 권한 프롬프트 1회 이상 → 리뷰 → 사용자 merge.
  3. 워커에게 `git push` 시도시키는 goal → 실패 확인.
  4. 게임/Foreman 재시작 후 스레드 resume.
- 성공 기준: `npm run check` 전부 통과, mod build 통과, 실기 1~4 통과, claude 백엔드 기존 동작 무변화.

## 7. 오픈 이슈
- [ ] 리드/워커 기본 모델과 effort 매핑 (Codex 쪽 모델 카탈로그는 `model/list`로 런타임 조회 가능 여부 확인 후 결정, 하드코딩 지양).
- [ ] `approvalPolicy` 정확한 값과 Windows 샌드박스 실제 동작 (실기 확인 필요).
- [ ] 비용 표시: 구독은 USD가 의미 없음 → 토큰/rate limit 표시로 대체할지, `/status` 문구 변경 범위.
- [ ] ChatGPT 구독을 서드파티 오케스트레이터에서 Codex 경유로 쓰는 것에 대한 OpenAI 정책 확인 (README 문구 결정).
- [ ] mod 배너가 긴 URL/코드를 보기 좋게 표시하는지 (2026-10-04: 프로토콜 확장 없이 `message`로 표시하도록 구현, CHECKING+codex+"Sign in" 메시지면 큰 배너. 실제 게임 화면 확인은 미완).
- [ ] thread/resume 후 dynamic tools가 유지되는지 (ThreadResumeParams에 dynamicTools 없음 → 스레드에 저장된다고 가정). 실기 확인 필요, 안 되면 resume 대신 새 스레드 + 요약 전달로 전환.
- [ ] Windows에서 Codex가 실행하는 명령 문자열 형태(PowerShell 래핑 여부)와 policy.ts 분류 결과 실기 확인.
- [ ] `claude-conflict.test.ts`가 전체 병렬 실행 시 1회 60초 타임아웃 (단독 12초 통과, 재실행 시 전체 통과). 부하성 플레이크로 판단, 재발 시 타임아웃 조정 검토.
- [ ] 이 작업을 upstream(blendi-remade/agentcraft)에 PR할지 여부 (그렇다면 한국어 docs는 분리).

## 8. 진행 로그
- 2026-10-04: 구조 조사. Claude 백엔드 결합 지점 파악(`query`, `canUseTool`+`policy.ts`, `createSdkMcpServer`, `StreamMapper`). Codex CLI 0.147.0 app-server 바인딩 생성으로 장치 인증/승인/dynamic tools 지원 확인. 계획서 초안 작성.
- 2026-10-04: 승인. 1단계 리팩터링 커밋 `ee9434f` (TeamBackend 추출, 485/485 무변경 통과).
- 2026-10-04: 실기 프로브: 전용 CODEX_HOME에서 `account/login/start chatgptDeviceCode` → `verificationUrl=https://auth.openai.com/codex/device`, `userCode` 정상 수신 (사용자 미입력으로 10분 후 timeout, 로그인 완료 경로는 fake로만 검증).
- 2026-10-04: 2~4단계 구현: `agents/codex/{appserver,auth,stream,index}.ts`, config `--backend codex`/`--codex-home`/`--codex-bin`, 프로토콜 `BackendName.codex`, mod enum + 로그인 배너, launch.ps1/mac.mjs. fake app-server(`test/fixtures/fake-codex.mjs`)로 로그인/전체 goal/승인/env 계약 테스트. 전체 488/488 통과, mod build 통과.
- 2026-10-04: 발견: Codex `shell_environment_policy` 기본 제외(`*KEY*`)가 `GIT_CONFIG_KEY_n`을 지움 → `ignore_default_excludes=true` 필수(ADR-0001). Windows npm 설치는 `codex.cmd` shim이라 `node .../@openai/codex/bin/codex.js`로 shell 없이 실행.
- 남은 것: 실기 검증(6절 1~4) — 사용자 장치 로그인 필요.
- 2026-10-04: 결정 변경(사용자 승인, A안): Codex CLI를 전역 설치 전제 대신 foreman의 **고정 버전 npm 의존성**(`@openai/codex@0.147.0`)으로 번들.
  실행 파일 탐색 순서 = `--codex-bin` > foreman/node_modules 번들 > PATH. 이유: 별도 설치 불필요 + experimental API(dynamic tools)를 검증한 버전에 고정해 프로토콜 드리프트 차단.
  대가: claude만 쓰는 사용자도 `npm ci` 시 Codex 플랫폼 바이너리 다운로드. 대안 B(첫 사용 시 설치)는 런처 밖 실행(`npm run start`)에서 수동 설치가 남아 기각. 번들 외 실행 파일은 버전 불일치 시 경고.
  구현 완료: lockfile에 6개 플랫폼 패키지 포함 확인, 실제 번들 CLI 기동 스모크 테스트(`test/codex-cli.test.ts`) 추가, 492/492 통과. Codex 업그레이드 = package.json 버전 변경 + 전체 테스트 + 실기 검증 후에만.
