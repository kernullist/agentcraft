# ADR-0002: 에이전트 런타임과 LLM 연결(Connection)의 분리

- 날짜: 2026-10-04
- 상태: 승인됨
- 관련: [[docs/plan/2026-10-04-multi-llm-connections.md]], [[docs/adr/0001-codex-backend-via-app-server.md]]

## 맥락
- `--backend claude|codex`가 "어떤 하네스로 에이전트를 돌리나(런타임)"와 "어떤 LLM에 어떻게 접속하나(연결)"를 한 값으로 묶고 있었다.
  그래서 DeepSeek 하나를 추가하는 일이 새 백엔드처럼 보였고, 전환은 재시작으로만 가능했으며 게임 안에서 설정할 방법이 없었다.
- DeepSeek은 공식 Anthropic 호환 엔드포인트(`https://api.deepseek.com/anthropic`)를 제공한다 → 기존 Claude 런타임으로 그대로 구동 가능.
- 제약: 인게임 승인 게이트·git 안전장치·세션 재개 등 기존 보장을 유지, 키는 클라이언트(mod)에 절대 노출 금지, 기존 실행 방식 무변화.

## 검토한 대안
- 프로바이더마다 백엔드 추가 + 재시작 전환 / 버린 이유: 실행 후 설정 UX 불가, 혼합 팀 불가, 클래스 증식.
- 자체 에이전트 루프(모든 LLM 직접 호출) / 버린 이유: 도구·샌드박스·승인·세션을 재구현해야 하고 안전 보장이 약해짐. 필요 시 세 번째 런타임으로.
- DeepSeek을 Codex 런타임(OpenAI 호환) 경유 / 버린 이유: 비-OpenAI 제공자 경로 + experimental dynamic tools로 위험이 겹침.
- 키를 config.json 평문 저장 / 버린 이유: 홈 백업·동기화로 유출.

## 결정
1. **런타임**(`claude` = Claude Agent SDK, `codex` = codex app-server)과 **연결**(provider + endpoint + 자격증명 참조 + 모델)을 분리한다.
   리드와 워커는 각각 연결을 배정받고(`lead`, `workers`), 매 턴 `RoutedBackend`가 그 연결의 런타임 러너로 보낸다.
2. 프로바이더 레지스트리(`connections/providers.ts`): `claude-env`(명령줄 환경 = 기존 동작), `anthropic-api`, `claude-login`, `cloud`, `deepseek`, `anthropic-compatible`, `chatgpt`.
   Claude 런타임 프로바이더는 상속된 Anthropic 변수를 먼저 지우고 자기 것만 설정한다(키·엔드포인트 교차 유출 차단).
3. 키는 OS 자격증명 저장소(`@napi-rs/keyring`) 또는 `env:VAR` 참조. 파일엔 참조만, 클라이언트엔 마스킹 값만. 키는 쓰기 전용.
4. 명령줄이 기술하는 연결(`cli`)은 저장하지 않는 기본값. 저장된 배정이 없으면 팀 전체가 이것을 쓴다 → 기존 실행 방식 그대로.
5. 배정 변경은 다음 턴부터. 세션은 연결 단위로 태그하고, 연결이 바뀐 작업은 재개 대신 새 세션 + 인계 프롬프트로 시작.
6. 인증 상태는 연결 단위. 한 역할의 연결 실패는 그 역할만 막는다.

## 근거
- DeepSeek이 공식 문서화한 경로를 그대로 쓰므로 도구·승인·세션 재개가 Claude와 동일하게 동작한다.
- 런타임 2개 × 프로바이더 N개 구조라 다음 프로바이더 추가는 레지스트리 항목 1개 + 테스트 함수 정도.
- 의도적으로 수용한 트레이드오프: 연결 전환 시 대화 이력 단절(인계 프롬프트로 보완), 비-Claude 엔드포인트는 USD 비용 대신 토큰 표시, 네이티브 keyring 모듈 의존.

## 결과 / 영향
- 좋아지는 것: 실행 중 연결 추가·테스트·배정(게임 `/connect`, TUI `/connect`), 혼합 팀(예: 리드 Claude, 워커 DeepSeek), 연결별 장애 격리.
- 감수할 것: 프로토콜 확장(추가 메시지만, 구버전 mod는 무시), keyring 미지원 환경은 env 참조만.
- 재검토 트리거: DeepSeek 호환 엔드포인트가 Claude Code 요청 필드를 거부하는 것이 실측될 때(capabilities로 옵션 차단 필요), Claude Agent SDK의 비-Anthropic 모델 사용이 약관상 금지로 확인될 때, 자체 런타임이 필요한 프로바이더(도구 호출 비호환)가 요구될 때.

## 변경 이력
- 2026-10-04: 최초 결정
