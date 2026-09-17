<div align="center">

<a href="https://www.dureai.dev/">
  <img src="../../public/readme/dure-logo.png" alt="Dure" width="88" height="88" />
</a>

# Dure

### 방향은 당신이.<br>에이전트들은 함께.

AI 코딩 에이전트를 위한 **Agent Development Environment (ADE)**.<br>
프로젝트, 대화, 터미널, 코드 변경을 하나의 macOS 작업 공간에 모았습니다.

**[macOS용 다운로드](https://www.dureai.dev/download/mac/)** &nbsp;·&nbsp; [웹사이트](https://www.dureai.dev/) &nbsp;·&nbsp; [문서](https://docs.dureai.dev/ko/introduction) &nbsp;·&nbsp; [X](https://x.com/hebbianai_) &nbsp;·&nbsp; [Discord](https://discord.gg/aTuRV6DXhb)

<sub>Apple Silicon · 평소 쓰던 코딩 에이전트 CLI와 계정 그대로</sub>

[English](../../README.md) · **한국어** · [简体中文](README.zh.md) · [日本語](README.ja.md) · [Español](README.es.md) · [Français](README.fr.md) · [Português](README.pt.md)

<br>

<a href="https://www.dureai.dev/#hero-film">
  <img src="../../public/readme/workspace-tour.webp" alt="Claude Code, Codex, Pi와 셸을 여섯 개 패널에 배치하고 Spaces에서 프로젝트와 세션을 함께 보는 Dure" width="960" />
</a>

**[▶ 29초로 보는 Dure](https://www.dureai.dev/#hero-film)** · [MP4 다운로드](https://raw.githubusercontent.com/hebbianai/dure/main/public/readme/workspace-tour.mp4)

<sub>샘플 프로젝트에서 실제 코딩 에이전트 CLI를 실행한 네이티브 앱 영상입니다.<br>GitHub 이슈 목록은 데모 데이터입니다. 개발 빌드로 촬영했으므로 다운로드 버전과 화면이 다를 수 있습니다.</sub>

</div>

## 에이전트가 늘어나도, 이끄는 곳은 하나.

어려운 건 에이전트를 하나 더 시작하는 일이 아닙니다. 어떤 작업에 내 판단이 필요한지, 무엇이 바뀌었는지, 다음에 무엇을 해야 하는지 파악하는 일입니다.

Dure는 그 일을 한곳에 모읍니다. Claude Code 옆에 Codex와 Pi를 두고, 여러 프로젝트와 SSH 호스트의 세션을 함께 살펴보세요. 변경 사항을 읽고, 피드백을 보내고, 다음 작업의 방향을 정하세요.

## 첫 작업부터 마지막 리뷰까지

### 01 — 목표로 시작하세요

**⌘N**을 누르고 작업을 설명한 뒤 프로젝트와 프로바이더를 선택하세요. 독립적으로 파일을 수정하는 작업에는 전용 Git worktree와 브랜치를 지정하세요. GitHub 이슈에서 **Start**를 선택하면 이슈 내용이 채워진 작업을 시작할 수도 있습니다.

### 02 — 필요한 곳에 시선을 두세요

패널을 나누고, 탭을 옮기고, 데스크톱을 전환하거나 세션을 별도 창으로 여세요. Spaces에서 로컬과 SSH 작업을 함께 보고, 활동·변경 표시로 확인이 필요한 작업을 찾을 수 있습니다.

<table>
<tr>
<td width="50%">
<a href="https://docs.dureai.dev/ko/quickstart"><img src="../../public/readme/start-agent.png" alt="Command-N으로 연 새 에이전트 창의 작업, 프로젝트, 프로바이더, 전용 worktree 옵션" width="460" /></a>
<br><sub>할 일을 설명하고, 에이전트를 고르세요.</sub>
</td>
<td width="50%">
<a href="https://docs.dureai.dev/ko/spaces-and-panes"><img src="../../public/readme/pane-arrangement.png" alt="실행 중인 터미널 탭을 Dure의 Split Right 위치로 드래그하는 모습" width="460" /></a>
<br><sub>화면은 옮기고, 작업 맥락은 유지하세요.</sub>
</td>
</tr>
</table>

### 03 — 검토하고 방향을 잡으세요

커밋 전 변경과 새 파일을 포함한 로컬 변경 사항을 확인하세요. 코드 줄에 댓글을 달아 에이전트에게 피드백으로 보낼 수 있습니다. 작업을 합치기 전에 변경 내용과 테스트 결과를 확인하세요. 다음 단계는 당신이 결정합니다.

[첫 에이전트 시작하기 →](https://docs.dureai.dev/ko/quickstart) &nbsp; [병렬 작업 →](https://docs.dureai.dev/ko/first-parallel-workflow) &nbsp; [리뷰와 피드백 →](https://docs.dureai.dev/ko/review-and-feedback)

## 에이전트의 작업을 둘러싼 도구들

| 이런 일이 필요할 때 | Dure에서 할 수 있는 일 |
| --- | --- |
| 독립적인 작업을 동시에 진행하기 | 전용 Git worktree와 브랜치로 작업별 파일 분리. |
| 실행 중인 작업을 한눈에 보기 | 여러 프로젝트의 Spaces, 분할 패널, 데스크톱, 별도 창. |
| 앱을 닫았다가 돌아오기 | 실행 중인 관리형 세션에 다시 연결하고, 종료된 프로세스는 별도 복구 흐름으로 처리. |
| 여러 머신에서 작업하기 | 로컬 작업 옆에 SSH 프로젝트와 원격 터미널을 두고 이미지 붙여넣기·파일 전송. |
| 기존 계정 활용하기 | 지원되는 프로바이더의 에이전트별 계정 프로필과 사용량 표시. |
| 반복 작업 연결하기 | CLI 실행·스케줄과 CLI/MCP 메시지, 의사결정 요청, 완료 보고. |
| 나에게 맞게 꾸미기 | 테마, 터미널 글꼴 설정, 7개 언어의 인터페이스. |

### 도구도, 계정도 그대로.

**Claude Code, Codex, Pi, Gemini CLI, OpenCode, Kimi Code** 같은 네이티브 코딩 에이전트 CLI를 사용하세요. Dure는 작업 공간이지, 모델이나 프로바이더 구독 상품이 아닙니다. 프로바이더 구독료와 사용 요금은 별도입니다.

터미널 지원, 대화 기록, 채팅 화면, 계정 도구의 범위는 프로바이더마다 다릅니다. [프로바이더별 지원 확인 →](https://docs.dureai.dev/ko/providers)

## Mac에서 시작하세요

1. Apple Silicon Mac에서 <strong><a href="https://www.dureai.dev/download/mac/">macOS용 Dure를 다운로드</a></strong>하세요. 디스크 이미지를 열고 앱을 **응용 프로그램** 폴더로 옮기세요.
2. 지원되는 코딩 에이전트 CLI를 하나 이상 설치하고 로그인하세요. macOS 보안 안내를 포함한 [설치 가이드](https://docs.dureai.dev/ko/install)를 확인하세요.
3. Dure에서 익숙한 Git 프로젝트를 여세요. **⌘N**을 누르고 작은 작업 하나로 시작하세요.

첫 요청은 이렇게 해보세요.

```text
이 저장소의 테스트를 실행하는 방법을 찾아줘.
파일은 수정하지 마.
실행 명령어와 그 명령어가 설명된 파일을 알려줘.
```

### 사용 전에 알아둘 점

- **Worktree는 파일을 분리할 뿐, 권한을 격리하지 않습니다.** 보안 샌드박스가 아니므로 자격 증명, 프로세스, 네트워크 접근은 격리되지 않습니다. 변경을 합칠 때 충돌이 생길 수도 있습니다.
- **호스트가 실행 중이어야 합니다.** 관리형 세션은 호스트 프로세스와 머신이 실행 중인 동안 앱 창과 별개로 계속 실행될 수 있습니다. 재부팅하면 원래 프로세스는 종료되며, 복구는 새 프로세스를 만듭니다.
- **검토는 여전히 필요합니다.** 작업을 받아들이기 전에 에이전트 권한, 변경 사항, 검증 결과를 확인하세요. 계정 전환과 원격 세션 동작에는 프로바이더·런타임별 제한이 있습니다.

[세션과 복구](https://docs.dureai.dev/ko/session-model) · [SSH](https://docs.dureai.dev/ko/remote-and-ssh) · [작업 안전 안내](https://docs.dureai.dev/ko/current-limits)

## 소스 공개 안내

**Open-source release: TBD. — 오픈소스 공개 일정 미정.**

**라이선스: [MIT](../../LICENSE) · Copyright (c) 2026 Hebbian AI.**

이 저장소는 제품 정보와 미디어를 소개하는 Dure의 공식 공개 GitHub 홈이며, 소스 코드를 공개할 저장소입니다. Dure 자체 소스 코드는 이곳에서 MIT 라이선스로 공개할 예정이며, 외부 구성 요소의 기존 라이선스와 저작권 고지는 유지합니다. 앱 소스 코드는 아직 공개되지 않았고, 소스 공개일은 미정입니다.

앱은 [웹사이트](https://www.dureai.dev/download/mac/)에서 다운로드할 수 있습니다. 이 저장소는 소스 배포본이나 소스 빌드 가이드가 아닙니다.

## 기여하기

[기여 가이드](../../CONTRIBUTING.md)와 [행동강령](../../CODE_OF_CONDUCT.md)을 확인하고, [버그를 제보하거나 기능을 제안](https://github.com/hebbianai/dure/issues/new/choose)해 주세요. 보안 취약점은 [보안 정책](../../SECURITY.md)에 안내된 비공개 경로로 제보해 주세요. 기여·운영 문서는 현재 영어로 제공됩니다.

---

<div align="center">

**방향은 당신이. 에이전트들은 함께.**

[Dure 다운로드](https://www.dureai.dev/download/mac/) · [문서 읽기](https://docs.dureai.dev/ko/introduction) · [dureai.dev](https://www.dureai.dev/) · [X](https://x.com/hebbianai_) · [Discord](https://discord.gg/aTuRV6DXhb)

</div>
