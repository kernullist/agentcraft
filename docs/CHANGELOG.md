# CHANGELOG

## 2026-10-04
- foreman: `--backend codex` 추가. ChatGPT 구독을 장치 인증(device code)으로 로그인해 공식 `codex app-server`로
  리드/워커를 실행. 승인 요청은 기존 policy.ts + 인게임 권한 프롬프트, 팀 도구는 dynamic tools. 결정: docs/adr/0001.
- foreman: 공통 오케스트레이션을 `agents/team/`(TeamBackend, 팀 도구, 프롬프트)으로 추출 (동작 무변경).
- mod: 프로토콜 `backend: codex` 인식, Codex 로그인 대기 시 URL/코드 배너 표시.
- tools: `launch.ps1 -Backend codex`, `mac.mjs --backend codex`.
- foreman: Codex CLI를 고정 버전 의존성(`@openai/codex@0.147.0`)으로 번들. 전역 설치 불필요, 다른 버전(`--codex-bin`/PATH)은 경고.
- foreman: `parseTestOutput`가 Node 23+ `node --test` 기본 spec 리포터 출력을 파싱하도록 수정.
  기존엔 TAP(`# tests N`)만 읽어 Node 23+에서 CI 결과 summary가 누락됨. 단위 테스트 추가.
  근거/재현: docs/research/windows-build-setup.md
