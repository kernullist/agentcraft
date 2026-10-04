# ADR-0001: ChatGPT 구독 백엔드는 `codex app-server` + 공통 TeamBackend로 구현

- 날짜: 2026-10-04
- 상태: 승인됨
- 관련: [[docs/plan/2026-10-04-codex-chatgpt-device-auth.md]]

## 맥락
- Foreman의 실제 에이전트 백엔드는 Claude Agent SDK 전용이었다 (`query()`, `canUseTool`, in-process MCP 도구, 세션 resume).
- ChatGPT 구독을 장치 인증(device code)으로 써서 같은 팀/같은 안전장치(worktree, 인게임 권한 프롬프트, git push 차단, 사용자 승인 merge)를 돌려야 한다.
- 제약: AgentCraft가 OpenAI 토큰을 다루지 않을 것, 인게임 승인 게이트를 잃지 않을 것, 기존 claude 경로 무회귀.

## 검토한 대안
- `@openai/codex-sdk` (`codex exec` JSONL): 승인 콜백 없음 → 사용자 승인 보장이 깨짐. 장치 로그인 API 없음. / 기각
- OAuth device flow 직접 구현 + Responses API: Codex client_id 사칭, 토큰 저장/갱신 책임, 에이전트 루프/도구/샌드박스 재구현. / 기각
- `ClaudeBackend` 복붙으로 `CodexBackend`: ~800줄 중복, 수정 이중화. / 기각
- 팀 도구를 Foreman의 HTTP MCP 엔드포인트로 제공: 안정 API지만 포트/토큰/턴 바인딩 추가 구현. / 보류 (dynamic tools가 깨질 때의 대체 경로)

## 결정
1. Codex는 공식 `codex app-server`(stdio JSON-RPC, IDE 확장과 같은 경로)로 구동한다. 턴마다 프로세스 1개, 에이전트별 환경변수.
2. 인증은 `account/login/start {type:"chatgptDeviceCode"}`: Codex가 OAuth를 수행하고 자격증명을 에이전트 전용 `CODEX_HOME`(`<home>/<profile>/codex`)에 저장. Foreman은 URL/코드만 중계.
3. 오케스트레이션은 추상 `TeamBackend`(agents/team/backend.ts)로 추출, 백엔드는 `checkAuth()`/`runTurn()`만 구현. 권한 게이트는 공통 `gate()`.
4. 팀 도구는 SDK 비의존 스펙(agents/team/tools.ts) → Claude는 MCP 서버로, Codex는 dynamic tools(experimental)로 감싼다.

## 근거
- app-server만이 장치 인증, 명령/파일 승인 요청, 클라이언트 처리 도구, resume/interrupt를 모두 공식 지원한다 (codex-cli 0.147.0 `generate-ts --experimental`로 확인).
- 토큰은 공식 Codex가 소유 → `--use-claude-login`과 같은 원칙(본인 로그인, 공식 CLI 경유).
- 턴당 프로세스: 에이전트별 git identity/안전 env를 프로세스 env로 강제할 수 있고, 중단 시 프로세스 트리 정리(기존 reap 로직)를 그대로 쓴다.
- 의도적으로 수용한 트레이드오프: dynamic tools는 experimental API, 턴당 프로세스 기동 비용(~1s).

## 결과 / 영향
- 좋아지는 것: `--backend codex`, 세 번째 백엔드 추가 비용이 `runTurn`/`checkAuth` 수준으로 감소, 권한 게이트 단일화.
- 감수할 것: Codex CLI 버전 의존(프로토콜 드리프트), Windows 샌드박스 강도 미검증, 구독은 USD 비용 표시가 없음(토큰 수만 로그).
- 안전장치 결정 사항:
  - `shell_environment_policy.inherit=all` + `ignore_default_excludes=true` 필수: 기본 제외 패턴 `*KEY*`가 `GIT_CONFIG_KEY_n`(git push 차단 설정)을 지워버린다.
  - `approvalPolicy=untrusted`, 리드 `read-only` / 워커 `workspace-write`(network off), `web_search=disabled`.
  - 샌드박스 추가 권한 요청(`item/permissions/requestApproval`)은 항상 거절, Codex 자체 사용자 질문(`requestUserInput`)은 빈 응답(질문은 ask_user로).
- 재검토 트리거: dynamic tools 제거/변경, thread/resume 후 dynamic tools 미유지, Windows에서 workspace-write가 worktree 밖 쓰기를 못 막는 것이 확인될 때, OpenAI 정책상 서드파티 오케스트레이션 금지 확인 시.

## 변경 이력
- 2026-10-04: 최초 결정
