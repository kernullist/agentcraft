# 작업 계획서: 다중 LLM 연결(Connections) 구조 + 인게임 연결 설정 UX (첫 대상: DeepSeek)

- 작성일: 2026-10-04
- 상태: 구현 완료, 실키 검증 대기 (2026-10-04 승인)
- 관련 문서: [[docs/adr/0001-codex-backend-via-app-server.md]], [[docs/plan/2026-10-04-codex-chatgpt-device-auth.md]]

## 1. 목표 / 배경
- 현재 구조의 한계:
  1. **백엔드 = 프로세스 시작 인자** (`--backend claude|codex|sim`). 바꾸려면 Foreman 재시작, 프로필도 백엔드 이름으로 갈림.
  2. "백엔드"가 두 가지 다른 것을 섞고 있음: **에이전트 런타임**(에이전트 루프·도구·샌드박스·승인을 가진 하네스: Claude Agent SDK, Codex app-server)과 **LLM 접속**(엔드포인트·인증·모델).
     그래서 "DeepSeek 추가"가 새 백엔드처럼 보이지만, 실제로는 기존 런타임에 접속처만 바꾸면 되는 일이다.
  3. 인증 정보는 env/CLI 플래그/config.json에만 있고, 게임 안에서 설정·확인·전환할 방법이 없음.
- 목표:
  1. **런타임**과 **연결(Connection)**을 분리. 연결 = 프로바이더 + 엔드포인트 + 자격증명 + 모델. 여러 개를 등록해 두고 리드/워커에 배정.
  2. **DeepSeek API** 지원 (첫 신규 프로바이더).
  3. **앱 실행 후** 게임 안(그리고 TUI)에서 연결 추가·테스트·전환·로그인하는 UX. 재시작 없이 다음 턴부터 적용.

### 사전 조사 (2026-10-04)
- DeepSeek은 공식 **Anthropic 호환 엔드포인트** `https://api.deepseek.com/anthropic` 제공. Claude Code를 `ANTHROPIC_BASE_URL` + 키로 붙이는 방법을 공식 문서화.
  같은 키로 OpenAI 호환(`https://api.deepseek.com`)도 사용 가능.
- 공식 호환표: 텍스트·도구 호출·tool_choice·thinking·스트리밍 지원, **cache_control 무시**, documents·서버측 MCP 커넥터·code execution 미지원.
  Claude 모델명은 자동 매핑(Opus → `deepseek-v4-pro`, Sonnet/Haiku → `deepseek-flash`, 미지원 이름 → flash).
- 결론: DeepSeek은 **기존 Claude 런타임(Agent SDK) + 다른 엔드포인트**로 지원 가능. 새 에이전트 루프 불필요.
  같은 방식으로 다른 Anthropic 호환 제공자(게이트웨이, 사내 프록시 등)도 "Anthropic 호환(커스텀)" 하나로 커버된다.

## 2. 범위
- 포함:
  1. foreman: `Connection` 모델, 프로바이더 레지스트리, 비밀값 저장(OS 자격증명 저장소), 리드/워커 배정, 런타임 라우팅(한 팀에서 리드=Claude, 워커=DeepSeek 같은 혼합 가능).
  2. 프로바이더: `anthropic-api`(키), `claude-login`(기존 개인용 옵션), `cloud`(Bedrock/Vertex/Foundry env), **`deepseek`**, `anthropic-compatible`(base URL+키), `chatgpt`(Codex 장치 인증, 기존).
  3. 실행 중 전환: 연결 추가/수정/삭제/테스트/배정/로그인 → 다음 턴부터 반영.
  4. 프로토콜: 연결 엔티티 + 클라이언트 메시지(추가 메시지만, 기존 호환).
  5. mod: **Connections 화면**(목록·추가 폼·테스트·배정·로그인), 콘솔 `/connect`, 연결이 없거나 실패 시 배너에서 바로 진입.
  6. TUI(`npm run tui`)에 같은 명령 (`/connect ...`) — 헤드리스·테스트용.
  7. 기존 `--backend claude|codex` / env / config.json은 **기본 연결로 자동 변환**(하위 호환).
- 제외(이번에 안 함):
  - 자체 에이전트 루프(모든 LLM을 직접 호출하는 런타임). 3절 C안 참고, 필요해지면 세 번째 런타임으로 추가.
  - OpenAI API 키(Codex 런타임 + API 키) — 구조상 쉬움, 이번엔 UI 항목만 예약.
  - 워커 개별 배정(워커마다 다른 연결). 이번엔 lead / workers 두 슬롯.
  - sim 백엔드 변경(시나리오 재생 백엔드라 연결 개념 밖. 그대로 `--backend sim`).
- 전제 조건 / 의존성:
  - DeepSeek API 키(사용자 제공, 실기 검증용).
  - 비밀값 저장용 네이티브 모듈 `@napi-rs/keyring`(Windows Credential Manager / macOS Keychain / libsecret, prebuilt 바이너리).

## 3. 접근안 비교

### 3-1. 다중 LLM 구조
| 안 | 요약 | 장점 | 단점 | 리스크 |
|---|---|---|---|---|
| A | 지금처럼 백엔드 추가 (`--backend deepseek`), 설정 파일 + 재시작 | 최소 변경 | 실행 중 전환·인게임 설정 불가, 혼합 팀 불가, 프로바이더마다 백엔드 클래스 증식 | 요구사항(실행 후 설정 UX) 미충족 |
| B | **런타임/연결 분리**: 연결 저장소 + 프로바이더 레지스트리 + 역할별 러너 라우팅 (TeamBackend는 그대로 공유) | 프로바이더 추가 = 레지스트리 항목 1개, 실행 중 전환, 혼합 팀 | 세션/비용/인증 상태를 연결 단위로 다시 정리해야 함 | 리팩터링 회귀(기존 claude/codex 테스트가 방어) |
| C | 자체 에이전트 루프 (Vercel AI SDK 등으로 모든 LLM 직접 호출) | 어떤 API든 붙음 | 도구·샌드박스·승인·세션 재개를 전부 재구현, 보안 표면 큼 | 품질·안전 보장 약화 |

**선택: B.** A는 핵심 요구(실행 후 설정)를 못 맞추고, C는 Claude Code/Codex가 이미 검증한 하네스를 버리는 비용이 크다. B에서 C는 나중에 "세 번째 런타임"으로 끼울 수 있다.

### 3-2. DeepSeek 연결 방식
| 안 | 요약 | 장점 | 단점 |
|---|---|---|---|
| A | **Claude 런타임 + Anthropic 호환 엔드포인트** | 공식 문서화된 경로, 도구·승인·세션 재개 그대로, 코드량 최소 | Claude Code가 보내는 일부 기능(캐싱·문서·일부 beta)이 무시/미지원 → 실기 확인 필요, SDK 비용 계산이 Claude 단가 기준 |
| B | Codex 런타임 + `model_providers`(OpenAI 호환) | OpenAI 호환 생태계 | Codex의 비-OpenAI 제공자 지원은 wire API 제약이 있고, dynamic tools(experimental)와 겹쳐 위험 두 배 |

**선택: A.** 비용 표시는 SDK 값 대신 토큰 사용량 × 프로바이더 단가표로 계산(단가 미상이면 토큰만 표시).

### 3-3. 비밀값(API 키) 저장
| 안 | 요약 | 판단 |
|---|---|---|
| A | config.json 평문 | 기각 (홈 디렉터리 백업·동기화로 유출) |
| B | **OS 자격증명 저장소** (`@napi-rs/keyring`) + 대체로 `env:VAR` 참조 | **선택**. 연결 파일엔 참조만 저장, 값은 저장소에. 모듈 로드 실패 시 env 참조만 허용하고 UI에 안내 |
| C | Windows DPAPI 직접(PowerShell) | Windows 전용, macOS 별도 구현 필요 → B의 내부 구현과 같으므로 불필요 |

규칙: 비밀값은 **쓰기 전용**. Foreman → mod 방향으로는 마스킹(`sk-…a1b2`)만, 로그·피드·디버그 출력에 절대 미기록(클라이언트 메시지 디버그 로그에서 해당 필드 마스킹).

### 3-4. 실행 중 전환과 세션
| 안 | 요약 | 판단 |
|---|---|---|
| A | 전환 즉시 진행 중 턴 중단 | 작업 손실·혼란 |
| B | **다음 턴부터 적용**(진행 중 턴은 끝까지), "지금 전환"은 기존 pause→resume 경로 재사용 | **선택** |

세션은 **연결 단위**로 묶는다(`sessions[key]`에 `connectionId` 기록). 다른 연결로 바뀐 작업은 세션 재개 대신 **새 세션 + 인계 프롬프트**(태스크 상태, 계획 메모리, 현재 diff 요약)로 시작. 이유: Claude 세션 ID ≠ Codex 스레드 ID이고, 같은 Claude 런타임이어도 엔드포인트가 바뀌면 thinking 블록 서명 등 이력 호환이 보장되지 않음.

## 4. 구현 단계
1. **연결 모델 + 저장소** (`foreman/src/connections/`): `Connection{id,name,provider,baseUrl?,secretRef?,models{lead?,worker?},effort?}`, `connections.json`(비밀 제외), `SecretStore`(keyring + env 참조), 배정 `{lead, workers}`. 기존 플래그/env/config → 기본 연결로 마이그레이션. 단위 테스트.
2. **프로바이더 레지스트리**: 프로바이더별 `fields`(UI 폼 스키마), `runtime`, `env(conn, secret)`, `test(conn)`, `listModels(conn)`, `pricing`, `capabilities`(effort 지원 여부 등).
   DeepSeek: `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`, `ANTHROPIC_AUTH_TOKEN`, 모델 env(`ANTHROPIC_MODEL`, 소형/빠른 모델 변수)까지 명시해 Claude 모델명이 새지 않게, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`. 모델 목록은 `GET /models`로 조회(하드코딩 지양).
3. **러너 라우팅**: `TeamBackend`가 잡마다 역할 → 연결 → 런타임 러너(`ClaudeRunner`/`CodexRunner`)를 선택. 기존 `ClaudeBackend`/`CodexBackend`의 `runTurn`/`checkAuth`를 연결 인자를 받는 러너로 전환. 인증 상태·authFailed를 **연결 단위**로(한 연결 실패가 다른 연결 역할을 막지 않게). 비용 집계 연결 단위.
4. **실행 중 변경 API** (Foreman 내부): add/update/delete/test/assign/login. 배정 변경 시 영향받는 대기 잡의 세션 처리(3-4).
5. **프로토콜**: 엔티티 `Connection`(마스킹된 비밀, 상태, 모델, 배정 역할) + `connection.upsert`/`connection.remove` 서버 메시지 + `snapshot.connections`; 클라이언트 `connection.save`, `connection.delete`, `connection.test`, `connection.assign`, `connection.login`, `connection.models`. `foreman.status`에 배정 요약. `docs/protocol.md` 재생성. 구버전 mod가 미지 메시지를 무시하는지 확인(5절).
6. **TUI**: `/connect` (목록), `/connect add deepseek`, `/connect test <id>`, `/connect use <id> [lead|workers|all]`, `/connect login <id>`, `/connect rm <id>` (키 입력은 TUI 프롬프트에서 비표시).
7. **mod Connections 화면**: 카드 목록(프로바이더, 상태 점, 모델, 배정 배지) / 추가·수정 폼(프로바이더 선택 → 필드, 비밀 입력 마스킹·붙여넣기, 모델 드롭다운은 `connection.models` 결과) / 테스트 결과 표시 / 리드·워커 배정 / ChatGPT 로그인 버튼(기존 장치 코드 배너 재사용). 진입: 콘솔 `/connect`, 키 바인딩, 인증 실패·미설정 배너에서 "연결 설정 열기".
   첫 실행에 연결이 하나도 없으면 실패 배너 대신 온보딩 안내.
8. **런처/문서**: `launch.ps1`/`run-codex.ps1`은 그대로 동작(마이그레이션). README "연결 설정" 절, ADR-0002(런타임/연결 분리), CHANGELOG, 연구 노트(DeepSeek 호환 실측).

## 5. 위험 및 실패 경로
- **DeepSeek 호환 공백**: Claude Code CLI가 보내는 beta 기능·effort·tool search(`alwaysLoad`) 등이 거부되거나 무시될 수 있음. 증상 = 400 에러, 도구 미사용. 탐지 = 연결 `test`에서 실제 도구 호출 1회 포함한 최소 턴, 실기 검증. 완화 = 프로바이더 `capabilities`로 effort 등 옵션 비활성화.
- **코드가 외부로 전송되는 위치**: DeepSeek API 서버로 저장소 코드·diff가 전송됨(Anthropic/OpenAI와 같은 성격이지만 관할·정책이 다름). 완화 = 연결 추가 화면과 문서에 "이 연결로 보내는 데이터의 목적지" 명시, 리포 단위로 허용 연결을 제한하는 옵션은 오픈 이슈.
- **비밀값 유출**: 디버그 로그(`validateOutbound`/수신 메시지 로그), 피드, 에러 메시지, 크래시 덤프. 완화 = 비밀 필드는 수신 즉시 SecretStore로 넘기고 메시지 객체에서 제거, 로그 마스킹 테스트 추가.
- **keyring 네이티브 모듈 실패**(prebuilt 없음, 리눅스 secret service 없음): 완화 = env 참조 모드로 폴백 + UI 안내.
- **혼합 팀 상호작용**: 리드(Claude)와 워커(DeepSeek)의 도구 사용 능력 차이 → 계획/리뷰 품질 편차. 기능 문제는 아님, 문서화.
- **비용 표시 오류**: SDK `total_cost_usd`가 Claude 단가로 계산됨 → DeepSeek 연결에선 SDK 값 무시, 토큰×단가.
- **회귀**: 러너 라우팅 리팩터링이 claude/codex 경로를 깨뜨릴 위험 → 기존 테스트(492) 유지, 단계별 커밋.
- **약관**: Claude Agent SDK/CLI를 비-Anthropic 모델에 쓰는 것의 라이선스·약관 범위 확인 필요(DeepSeek은 공식 안내하지만 Anthropic 측 조건은 별도). 오픈 이슈.
- **구버전 mod 호환**: 미지 메시지 타입을 무시하지 않으면 연결 메시지로 오류 발생 가능 → mod의 처리 방식 확인 후 필요하면 hello에서 기능 협상.

## 6. 검증 방법
- 단위: 연결 저장소(비밀 분리·마스킹·마이그레이션), 프로바이더 env 생성(DeepSeek 변수 전체), 라우팅(역할별 러너 선택, 연결 실패 격리), 세션 연결 바인딩·인계 프롬프트, 프로토콜 스키마, 로그 마스킹.
- 통합(가짜 SDK/가짜 app-server): 실행 중 워커 연결을 Claude → DeepSeek(가짜)로 바꾸고 다음 턴이 새 env·새 세션으로 시작되는지, 리드는 영향 없는지.
- 실기(사용자 DeepSeek 키 필요): 연결 추가 → 테스트 → 워커 배정 → 데모 리포 goal 하나를 끝까지(도구 호출·권한 프롬프트·merge), 비용/토큰 표시, 키가 로그·화면 어디에도 평문으로 없는지 검색.
- mod: 화면 스크린샷 QA(DevBridge `dev.screen`), 키보드만으로 추가→테스트→배정 흐름.
- 성공 기준: `npm run check` 전부 통과, mod build, 위 실기 항목 통과, 기존 `--backend` 실행 방식 무변화.

## 7. 오픈 이슈
- [ ] Claude Agent SDK/CLI를 DeepSeek 등 비-Anthropic 엔드포인트에 쓰는 것의 약관 범위.
- [ ] DeepSeek이 Claude Code의 어떤 요청 필드에서 실패하는지 실측(effort, beta 헤더, tool search).
- [ ] DeepSeek 단가표 출처와 갱신 방식(하드코딩 vs 설정).
- [ ] 리포 단위 "허용 연결" 제한(민감 리포를 특정 프로바이더로 보내지 않기) 필요 여부.
- [ ] 워커 개별 배정을 다음 단계로 할지.
- [x] 연결 설정 화면 진입 키 바인딩 기본값 → 2026-10-04: 없음(콘솔 `/connect` + 배너 안내). 필요하면 추가.

## 8. 진행 로그
- 2026-10-04: 현재 구조 분석(백엔드 = 프로세스 인자, 런타임/접속 혼재). DeepSeek 공식 Anthropic 호환 엔드포인트·호환표 확인. 계획서 초안.
- 2026-10-04: 승인. 구현 커밋: `137b7ca`(연결 계층 + 러너 분리, 기존 492 테스트 무수정 통과), `aa33456`(프로토콜·Foreman·TUI, 517 통과), `ad40b95`(mod Connections 화면).
- 2026-10-04: 결정 세부: DeepSeek 기본 모델은 하드코딩 대신 Claude 별칭(opus/sonnet)을 보내 DeepSeek 측 매핑에 맡김. 모델 목록은 OpenAI 호환 루트 `GET /models`로 조회(토큰 비용 없음).
  비-Claude 엔드포인트는 SDK USD 대신 토큰 표시, USD 예산 상한 미적용. 키 저장은 `@napi-rs/keyring@2.1.0`(Windows 자격 증명 관리자 동작 확인).
  진입 키 바인딩은 기본 없음 — 콘솔 `/connect`와 인증 배너 안내로 진입(오픈 이슈였던 기본값 결정).
- 2026-10-04: 실측: 게임 dev 클라이언트에서 가짜 키로 DeepSeek 연결 저장 → 실제 엔드포인트가 HTTP 401 → 실패 상태·마스킹 키 표시, 로그 어디에도 키 없음, 삭제 시 자격증명 저장소에서도 제거 확인.
  이 PC 환경엔 원래 `ANTHROPIC_BASE_URL`이 설정돼 있음 → `claude-env`(cli) 연결은 이를 그대로 상속(의도된 기존 동작), 다른 연결은 지우고 자기 값만 설정.
- 2026-10-04: `run-deepseek.ps1` 추가(사용자 요청). 가짜 키로 env/stdin 두 경로 모두 실제 DeepSeek 401 확인.
- 남은 것: 실제 DeepSeek 키로 goal 1개 끝까지(도구 호출·승인·merge) — 사용자 키 필요. Claude Code 요청 필드 중 DeepSeek이 거부하는 것이 있는지 실측.
