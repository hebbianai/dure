// 설정 화면의 provider별 배선 상태 — 읽기 전용 프로브만 모은다.
// mutate-to-probe(ensure류 재사용) 금지: 상태 조회가 부작용을 만들면 화면을
// 여는 것만으로 오버레이가 바뀐다.

use serde::Serialize;
use std::path::Path;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderWiringStatus {
    pub claude: ClaudeWiring,
    pub codex: CodexWiring,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeWiring {
    /// managed 훅 설정(managed-claude-settings.json)이 이 앱 프로세스 발행
    /// 그대로이고 owner-only channel bridge가 유효한가 — 완료 알림이 훅
    /// 이벤트(정확) 기반인지의 근거.
    pub managed_hooks_published: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexWiring {
    /// notify 스크립트·토큰이 발행·검증 통과 상태인가.
    pub notify_published: bool,
    /// 활성 계정 오버레이의 호환 합성 상태 — 계정 오버레이가 없으면 None.
    /// 실제 managed launch 주입은 계정 종류와 무관하게 `notify_published`를
    /// 검증하고 적용하므로 이 값은 completion source의 전제 조건이 아니다.
    pub overlay: Option<crate::accounts::CodexOverlayWiring>,
}

/// 홈 아래의 실제 디렉터리만 허용 — 화면이 넘긴 경로로 임의 파일을 읽지
/// 않게 한다(계정 dir는 항상 $HOME 아래에 만들어진다).
fn validated_account_directory(home: &Path, dir: &str) -> Option<std::path::PathBuf> {
    if dir.is_empty() || dir.contains("..") {
        return None;
    }
    let path = Path::new(dir);
    if !path.is_absolute() || !path.starts_with(home) || !path.is_dir() {
        return None;
    }
    Some(path.to_path_buf())
}

#[tauri::command(async)]
pub fn provider_wiring_status(
    codex_account_dir: Option<String>,
) -> Result<ProviderWiringStatus, String> {
    let home = dirs::home_dir().ok_or_else(|| "Could not find the home directory".to_string())?;
    let overlay = codex_account_dir
        .as_deref()
        .and_then(|dir| validated_account_directory(&home, dir))
        .map(|dir| crate::accounts::codex_overlay_wiring(&home, &dir));
    Ok(ProviderWiringStatus {
        claude: ClaudeWiring {
            managed_hooks_published: crate::managed_hooks::claude_settings_available(),
        },
        codex: CodexWiring {
            notify_published: crate::managed_hooks::codex_notify_command().is_some(),
            overlay,
        },
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderWiringFile {
    pub path: String,
    pub content: String,
    pub truncated: bool,
}

/// raw 뷰어의 본문 상한 — 프론트 IPC payload를 유계로 유지한다.
const WIRING_FILE_MAX_BYTES: usize = 64 * 1024;

/// 화면에 그대로 실리는 내용에서 Bearer 토큰만 가린다. 현재 managed Claude
/// 설정은 token-free지만 이전 HTTP 설정과 사용자 소유 config를 열 때도 안전한
/// compatibility guard다. 그 외 내용은 손대지 않는다.
fn redact_bearer_tokens(content: &str) -> String {
    let mut redacted = String::with_capacity(content.len());
    let mut rest = content;
    while let Some(index) = rest.find("Bearer ") {
        let (head, tail) = rest.split_at(index + "Bearer ".len());
        redacted.push_str(head);
        let token_len = tail
            .chars()
            .take_while(|character| character.is_ascii_alphanumeric())
            .count();
        if token_len > 0 {
            redacted.push_str("●●●●●●●●");
        }
        rest = &tail[token_len..];
    }
    redacted.push_str(rest);
    redacted
}

fn wiring_file(path: std::path::PathBuf) -> Result<ProviderWiringFile, String> {
    let content =
        std::fs::read_to_string(&path).map_err(|error| format!("Could not read the file: {error}"))?;
    let truncated = content.len() > WIRING_FILE_MAX_BYTES;
    let bounded = if truncated {
        let mut end = WIRING_FILE_MAX_BYTES;
        while !content.is_char_boundary(end) {
            end -= 1;
        }
        &content[..end]
    } else {
        content.as_str()
    };
    Ok(ProviderWiringFile {
        path: path.to_string_lossy().into_owned(),
        content: redact_bearer_tokens(bounded),
        truncated,
    })
}

/// 배선 상태 행이 가리키는 실제 파일의 raw 내용 — 종류는 enum으로 게이트한다
/// (임의 경로 읽기 금지). 토큰 파일(managed-codex-notify-token.curl)은
/// 의도적으로 제외한다.
#[tauri::command(async)]
pub fn provider_wiring_file(
    kind: String,
    codex_account_dir: Option<String>,
) -> Result<ProviderWiringFile, String> {
    let home = dirs::home_dir().ok_or_else(|| "Could not find the home directory".to_string())?;
    match kind.as_str() {
        "claudeManagedSettings" | "codexNotifyScript" => {
            let channel = crate::app_channel::current().map_err(|error| error.to_string())?;
            let name = if kind == "claudeManagedSettings" {
                "managed-claude-settings.json"
            } else {
                "managed-codex-notify.sh"
            };
            wiring_file(channel.control_dir.join(name))
        }
        "codexOverlayConfig" => {
            let directory = codex_account_dir
                .as_deref()
                .and_then(|dir| validated_account_directory(&home, dir))
                .ok_or_else(|| "No active Codex account overlay was found".to_string())?;
            wiring_file(directory.join("config.toml"))
        }
        "codexCanonicalConfig" => wiring_file(home.join(".codex/config.toml")),
        "codexCanonicalHooks" => wiring_file(home.join(".codex/hooks.json")),
        _ => Err("Unsupported file type".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bearer_tokens_are_redacted_and_content_is_bounded() {
        assert_eq!(
            redact_bearer_tokens("\"Authorization\": \"Bearer abc123DEF\" and Bearer ffff."),
            "\"Authorization\": \"Bearer ●●●●●●●●\" and Bearer ●●●●●●●●."
        );
        // 토큰이 아닌 곳은 그대로 둔다.
        assert_eq!(redact_bearer_tokens("no tokens here"), "no tokens here");

        let directory = std::env::temp_dir().join(format!(
            "dure-wiring-file-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("big.toml");
        std::fs::write(&path, "a".repeat(WIRING_FILE_MAX_BYTES + 10)).unwrap();
        let file = wiring_file(path).unwrap();
        assert!(file.truncated);
        assert_eq!(file.content.len(), WIRING_FILE_MAX_BYTES);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn wiring_file_kinds_are_enum_gated() {
        assert!(provider_wiring_file("../../etc/passwd".to_string(), None)
            .is_err());
        // 오버레이 종류는 검증된 계정 dir 없이는 거부된다.
        assert!(provider_wiring_file("codexOverlayConfig".to_string(), Some("/etc".to_string()))
            .is_err());
    }

    #[test]
    fn account_directory_validation_rejects_escapes_and_relative_paths() {
        let home = std::env::temp_dir();
        let inside = home.join("dure-wiring-test-dir");
        std::fs::create_dir_all(&inside).unwrap();
        assert!(validated_account_directory(&home, inside.to_str().unwrap()).is_some());
        assert!(validated_account_directory(&home, "").is_none());
        assert!(validated_account_directory(&home, "relative/dir").is_none());
        assert!(
            validated_account_directory(&home, &format!("{}/../etc", home.display())).is_none()
        );
        assert!(validated_account_directory(&home, "/etc").is_none());
        std::fs::remove_dir_all(inside).unwrap();
    }
}
