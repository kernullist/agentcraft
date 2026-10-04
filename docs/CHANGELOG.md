# CHANGELOG

## 2026-10-04
- foreman: `parseTestOutput`가 Node 23+ `node --test` 기본 spec 리포터 출력을 파싱하도록 수정.
  기존엔 TAP(`# tests N`)만 읽어 Node 23+에서 CI 결과 summary가 누락됨. 단위 테스트 추가.
  근거/재현: docs/research/windows-build-setup.md
