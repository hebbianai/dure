// 앱 홈(`~/.dure`) 해석 — node 스크립트 계층의 단일 진실. Rust 쪽
// src-tauri/src/app_home.rs 와 같은 계약이다:
//   DURE_HOME > ~/.dure
// `.hebbian`은 migrate-home의 bounded read-only 입력일 뿐, 정상 실행 경로가
// 선택하거나 새로 만드는 writable root가 아니다.
import { homedir } from "node:os";
import { join } from "node:path";

export const APP_DIR_NAME = ".dure";

/** 명시된 home 아래에서 canonical 앱 루트를 고른다. **env는 보지 않는다** — disposable
 * HOME 픽스처에 ambient env가 새어들면 격리가 깨진다(2026-07-31 러너 픽스처
 * 사고와 같은 규칙: 상속 환경이 명시 인자를 이기면 어떤 픽스처도 안전하지
 * 않다). 경로가 이미 파일이거나 unsafe symlink면 실제 writer가 fail-closed로
 * 거부해야 하며, legacy root로 돌아가 writable state를 분기하면 안 된다. */
export function appRootUnder(home) {
  return join(home, APP_DIR_NAME);
}

/** 실행 환경의 앱 루트. 빈 `DURE_HOME`은 미지정으로 본다. */
export function appRoot(environment = process.env) {
  const override = environment.DURE_HOME;
  if (override) return override;
  return appRootUnder(homedir());
}
