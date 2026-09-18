<div align="center">

<a href="https://www.dureai.dev/">
  <img src="../../public/readme/dure-logo.png" alt="Dure" width="88" height="88" />
</a>

# Dure

### 방향은 당신이.<br>에이전트들은 함께.

AI 코딩 에이전트를 위한 **오픈소스 작업 공간**.<br>
전용 worktree와 코드 리뷰를 활용해 여러 프로젝트와 SSH 호스트의 Claude Code, Codex, Pi를 한곳에서 이끄세요.

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

## 작업을 이어가는 네 가지 방법

### 에이전트는 병렬로, worktree는 따로

**⌘N**이나 GitHub 이슈에서 에이전트를 시작하세요. 프로젝트와 프로바이더를 고르고, 독립적으로 파일을 수정하는 작업에는 전용 Git worktree와 브랜치를 지정할 수 있습니다.

[병렬 작업 시작하기 →](https://docs.dureai.dev/ko/first-parallel-workflow)

<a href="https://docs.dureai.dev/ko/first-parallel-workflow">
  <img src="../../public/readme/start-agent.png" alt="작업, 프로바이더, 전용 worktree 옵션을 선택하세요." width="880" />
</a>

<sub>작업, 프로바이더, 전용 worktree 옵션을 선택하세요.</sub>

### 로컬과 SSH 작업을 모으는 Spaces

프로젝트와 세션을 Spaces로 묶으세요. 패널을 나누고 탭을 옮기거나 별도 창을 열어 로컬과 SSH 작업을 함께 살펴볼 수 있습니다.

[Spaces와 패널 →](https://docs.dureai.dev/ko/spaces-and-panes) · [SSH 설정](https://docs.dureai.dev/ko/remote-and-ssh)

<a href="https://docs.dureai.dev/ko/spaces-and-panes">
  <img src="../../public/readme/pane-arrangement.png" alt="샘플 프로젝트에서 실행 중인 에이전트 패널을 배치하는 모습입니다." width="880" />
</a>

<sub>샘플 프로젝트에서 실행 중인 에이전트 패널을 배치하는 모습입니다.</sub>

### 대화 옆에서 검토하는 코드

커밋 전 변경과 새 파일을 포함한 로컬 diff를 확인하세요. 파일이나 코드 줄에 댓글을 달아 연결된 에이전트에게 보내고, 작업을 합치기 전에 다음 수정본을 검토할 수 있습니다.

[리뷰와 피드백 →](https://docs.dureai.dev/ko/review-and-feedback)

<a href="https://docs.dureai.dev/ko/review-and-feedback">
  <img src="../../docs/public/images/diff-review.png" alt="리뷰 댓글을 달기 전에 샘플 프로젝트의 변경 내용을 확인하는 화면입니다." width="880" />
</a>

<sub>리뷰 댓글을 달기 전에 샘플 프로젝트의 변경 내용을 확인하는 화면입니다.</sub>

### CLI 실행·예약과 에이전트 조정

Dure CLI로 작업을 실행하고 반복 작업을 예약하세요. CLI와 MCP 통합을 통해 사람과 에이전트가 진행 메시지, 판단 요청, 완료 보고를 주고받을 수 있습니다.

```sh
dure run --provider codex --worktree readme-review \
  "Review the README against the code. Do not change files."
dure ls
```

[CLI 실행과 예약 →](https://docs.dureai.dev/ko/cli-and-automation) · [메시지와 판단 요청](https://docs.dureai.dev/ko/orchestration)

## 지원 에이전트

**Claude Code · Codex · Pi · OpenCode · Gemini CLI · Kimi Code**

설치된 코딩 에이전트 CLI와 기존 프로바이더 계정을 그대로 사용하세요. 모델 이용권, 구독, 사용 요금은 각 프로바이더에서 관리합니다.

Claude Code, Codex, OpenCode, Pi는 설치된 런타임이 지원할 때 구조화된 채팅 통합을 제공합니다. 터미널, 대화 기록, 이어하기, 계정 기능은 프로바이더마다 다릅니다. [프로바이더별 기능 확인 →](https://docs.dureai.dev/ko/providers)

## 설치와 플랫폼별 지원 현황

| 플랫폼 | 현재 제공 범위 |
| --- | --- |
| macOS · Apple Silicon | [공식 다운로드](https://www.dureai.dev/download/mac/) |
| Windows | 소스 공개 · 네이티브 데스크톱 검증과 공개 설치 파일은 준비 단계 |
| Linux | 소스 공개 · 네이티브 데스크톱 검증과 공개 설치 파일은 준비 단계 |
| iOS | 소스 공개 · 기기 검증과 공식 배포는 준비 단계 |
| Android | 소스 공개 · 기기 검증과 공식 배포는 준비 단계 |

소스 빌드와 검증 범위는 다음 안내를 참고하세요: [플랫폼별 개발 안내](../../CONTRIBUTING.md#platforms).

### Mac에서 시작하기

1. Apple Silicon Mac에서 <strong><a href="https://www.dureai.dev/download/mac/">macOS용 Dure를 다운로드</a></strong>하세요. 디스크 이미지를 열고 앱을 **응용 프로그램** 폴더로 옮기세요.
2. 지원되는 코딩 에이전트 CLI를 하나 이상 설치하고 로그인하세요. macOS 보안 안내를 포함한 [설치 가이드](https://docs.dureai.dev/ko/install)를 확인하세요.
3. Dure에서 익숙한 Git 프로젝트를 여세요. **⌘N**을 누르고 작은 작업 하나로 시작하세요.

<details>
<summary>사용 전에 알아둘 점</summary>

- **Worktree는 파일을 분리할 뿐, 권한을 격리하지 않습니다.** 보안 샌드박스가 아니므로 자격 증명, 프로세스, 네트워크 접근은 격리되지 않습니다. 변경을 합칠 때 충돌이 생길 수도 있습니다.
- **호스트가 실행 중이어야 합니다.** 관리형 세션은 호스트 프로세스와 머신이 실행 중인 동안 앱 창과 별개로 계속 실행될 수 있습니다. 재부팅하면 원래 프로세스는 종료되며, 복구는 새 프로세스를 만듭니다.
- **검토는 여전히 필요합니다.** 작업을 받아들이기 전에 에이전트 권한, 변경 사항, 검증 결과를 확인하세요. 계정 전환과 원격 세션 동작에는 프로바이더·런타임별 제한이 있습니다.

[세션과 복구](https://docs.dureai.dev/ko/session-model) · [SSH](https://docs.dureai.dev/ko/remote-and-ssh) · [작업 안전 안내](https://docs.dureai.dev/ko/current-limits)

</details>

## 오픈소스 공개 범위

이 저장소에 공개된 데스크톱·모바일·런타임(Hmux 포함)·CLI·서비스 자체 코드는 [GNU GPL 버전 3 전용(GPL-3.0-only)](../../LICENSE)으로 제공되며, 외부 구성 요소의 라이선스와 고지는 유지됩니다. 해당 라이선스에 따라 사용·수정·재배포할 수 있습니다. GPL 적용 바이너리를 배포할 때는 GPLv3가 정한 방식으로 해당 소스 코드(Corresponding Source)를 제공해야 합니다. 이전에 MIT로 공개된 버전에는 기존 MIT 조건이 계속 적용됩니다.

Dure 이름·로고·앱 아이콘의 사용과 커뮤니티 빌드·Hebbian AI 공식 빌드의 구분은 [TRADEMARK.md](../../TRADEMARK.md)에 안내되어 있습니다.

소스 라이선스는 운영 서비스 접근권을 포함하지 않습니다. 서명 키, 배포 자격 증명, 기밀 사업·운영자료는 비공개로 유지합니다.

## 기여하기

[기여 가이드](../../CONTRIBUTING.md)와 [행동강령](../../CODE_OF_CONDUCT.md)을 확인하고, [버그를 제보하거나 기능을 제안](https://github.com/hebbianai/dure/issues/new/choose)해 주세요. 보안 취약점은 [보안 정책](../../SECURITY.md)에 안내된 비공개 경로로 제보해 주세요. 기여·운영 문서는 현재 영어로 제공됩니다.

- **릴리스 노트:** [GitHub Releases](https://github.com/hebbianai/hebbian-releases/releases)
- **개인정보와 사용 데이터:** [개인정보와 사용 데이터](https://docs.dureai.dev/ko/privacy-and-telemetry)
- **커뮤니티:** [Discord](https://discord.gg/aTuRV6DXhb)
- **소식:** [X · @hebbianai_](https://x.com/hebbianai_)

---

<div align="center">

**방향은 당신이. 에이전트들은 함께.**

[Dure 다운로드](https://www.dureai.dev/download/mac/) · [문서 읽기](https://docs.dureai.dev/ko/introduction) · [dureai.dev](https://www.dureai.dev/) · [X](https://x.com/hebbianai_) · [Discord](https://discord.gg/aTuRV6DXhb)

</div>
