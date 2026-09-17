//! Read-only provider login status and display identity (email and plan).
//!
//! Only authentication state and display-safe identity fields cross IPC;
//! outbound credential transfers keep tokens inside the native adapter.
//! Missing credentials are distinct from unreadable or unknown formats so the
//! UI offers login only when unauthenticated state is confirmed.

use base64::Engine as _;
use serde::Serialize;
#[cfg(target_os = "macos")]
use sha2::{Digest as _, Sha256};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
#[cfg(target_os = "macos")]
use std::process::{Command, Stdio};

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LoginStatus {
    Authenticated,
    Unauthenticated,
    Unknown,
}

#[derive(Debug, PartialEq, Serialize)]
pub struct LoginIdentity {
    pub status: LoginStatus,
    pub email: Option<String>,
    pub plan: Option<String>,
}

fn identity(status: LoginStatus) -> LoginIdentity {
    LoginIdentity {
        status,
        email: None,
        plan: None,
    }
}

/// CLAUDE_CONFIG_DIR 루트의 `.claude.json`에서 `oauthAccount.emailAddress`만
/// 읽는다. 계정 overlay는 `{dir}/.claude.json`, 시스템 기본은 `~/.claude.json`
/// — Claude Code는 CLAUDE_CONFIG_DIR 미설정 시 홈 루트에 쓴다.
fn claude_identity_at(config_root: &Path, status: LoginStatus) -> LoginIdentity {
    let value = std::fs::read_to_string(config_root.join(".claude.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok());
    LoginIdentity {
        status,
        email: value
            .as_ref()
            .and_then(|value| value.pointer("/oauthAccount/emailAddress"))
            .and_then(|v| v.as_str())
            .map(str::to_owned),
        plan: None,
    }
}

fn file_credential_status(path: &Path) -> LoginStatus {
    match std::fs::metadata(path) {
        Ok(metadata) if metadata.is_file() && metadata.len() > 0 => LoginStatus::Authenticated,
        Ok(_) => LoginStatus::Unknown,
        Err(error) if error.kind() == ErrorKind::NotFound => LoginStatus::Unauthenticated,
        Err(_) => LoginStatus::Unknown,
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn claude_keychain_service(scoped_config_root: Option<&str>) -> String {
    match scoped_config_root {
        None => "Claude Code-credentials".to_string(),
        Some(root) => {
            let digest = format!("{:x}", Sha256::digest(root.as_bytes()));
            format!("Claude Code-credentials-{}", &digest[..8])
        }
    }
}

/// Read only the selected profile's native store for an outbound SSH transfer.
/// The caller validates the profile directory; never substitute the default store.
#[cfg(target_os = "macos")]
pub(crate) fn read_claude_keychain_credential(config_root: &str) -> Result<Option<Vec<u8>>, String> {
    let service = claude_keychain_service(Some(config_root));
    let output = Command::new("/usr/bin/security")
        .args(["find-generic-password", "-s", &service, "-w"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .map_err(|_| "credential_transfer_unavailable: cannot read Claude Keychain".to_string())?;
    if output.status.code() == Some(44) {
        return Ok(None);
    }
    if !output.status.success() {
        return Err("credential_transfer_unavailable: Claude Keychain access failed".to_string());
    }
    if output.stdout.len() > 4 * 1024 * 1024 {
        return Err(
            "credential_transfer_too_large: Claude Keychain credential exceeds 4 MiB".to_string(),
        );
    }
    let valid = serde_json::from_slice::<serde_json::Value>(&output.stdout)
        .ok()
        .is_some_and(|value| value.as_object().is_some_and(|object| !object.is_empty()));
    if !valid {
        return Err("credential_transfer_unavailable: invalid Claude Keychain credential".to_string());
    }
    Ok(Some(output.stdout))
}

#[cfg(target_os = "macos")]
fn claude_credential_status(
    credential_root: &Path,
    scoped_config_root: Option<&str>,
) -> LoginStatus {
    let file_status = file_credential_status(&credential_root.join(".credentials.json"));
    if file_status == LoginStatus::Authenticated {
        return file_status;
    }
    let service = claude_keychain_service(scoped_config_root);
    match Command::new("/usr/bin/security")
        .args(["find-generic-password", "-s", &service])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
    {
        Ok(status) if status.success() => LoginStatus::Authenticated,
        Ok(status) if status.code() == Some(44) => file_status,
        _ => LoginStatus::Unknown,
    }
}

#[cfg(not(target_os = "macos"))]
fn claude_credential_status(
    credential_root: &Path,
    _scoped_config_root: Option<&str>,
) -> LoginStatus {
    file_credential_status(&credential_root.join(".credentials.json"))
}

/// CODEX_HOME 루트의 `auth.json`에서 `tokens.id_token` JWT payload의
/// 이메일·플랜만 읽는다. 서명 검증은 하지 않는다 — 로컬 파일의 표시용
/// 파싱일 뿐이다. API 키 로그인(auth.json에 tokens 없음)은 빈 정체성.
fn codex_identity_at(codex_home: &Path) -> LoginIdentity {
    let value: serde_json::Value = match std::fs::read_to_string(codex_home.join("auth.json")) {
        Ok(text) => match serde_json::from_str(&text) {
            Ok(value) => value,
            Err(_) => return identity(LoginStatus::Unknown),
        },
        Err(error) if error.kind() == ErrorKind::NotFound => {
            return identity(LoginStatus::Unauthenticated);
        }
        Err(_) => return identity(LoginStatus::Unknown),
    };
    let authenticated = value
        .pointer("/tokens/access_token")
        .and_then(|value| value.as_str())
        .is_some_and(|value| !value.is_empty())
        || value
            .pointer("/tokens/id_token")
            .and_then(|value| value.as_str())
            .is_some_and(|value| !value.is_empty())
        || value
            .get("OPENAI_API_KEY")
            .and_then(|value| value.as_str())
            .is_some_and(|value| !value.is_empty());
    if !authenticated {
        return identity(LoginStatus::Unknown);
    }
    let payload = value
        .pointer("/tokens/id_token")
        .and_then(|v| v.as_str())
        .and_then(decode_jwt_payload);
    LoginIdentity {
        status: LoginStatus::Authenticated,
        email: payload
            .as_ref()
            .and_then(|payload| payload.get("email"))
            .and_then(|v| v.as_str())
            // 구형 토큰은 최상위 email 없이 profile claim에만 넣는다
            .or_else(|| {
                payload
                    .as_ref()?
                    .pointer("/https:~1~1api.openai.com~1profile/email")
                    .and_then(|v| v.as_str())
            })
            .map(str::to_owned),
        plan: payload
            .as_ref()
            .and_then(|payload| {
                payload.pointer("/https:~1~1api.openai.com~1auth/chatgpt_plan_type")
            })
            .and_then(|v| v.as_str())
            .map(str::to_owned),
    }
}

fn decode_jwt_payload(token: &str) -> Option<serde_json::Value> {
    let payload = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// `dir`은 계정 overlay 디렉터리(accounts 모듈이 만든 것), 비어 있으면 시스템
/// 기본 로그인(canonical 홈)을 읽는다. 파일 읽기가 있으므로 async 러너에서
/// 돈다 — 느린 홈(네트워크/FUSE)에서 IPC 디스패치를 막지 않는다.
#[tauri::command(async)]
pub fn account_login_identity(
    provider: String,
    dir: Option<String>,
) -> Result<LoginIdentity, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let root = dir
        .as_deref()
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    Ok(match provider.as_str() {
        "claude" => {
            let identity_root = root.as_deref().unwrap_or_else(|| Path::new(&home));
            let credential_root = root
                .as_deref()
                .map(Path::to_path_buf)
                .unwrap_or_else(|| PathBuf::from(&home).join(".claude"));
            let status = claude_credential_status(&credential_root, dir.as_deref());
            claude_identity_at(identity_root, status)
        }
        "codex" => codex_identity_at(&root.unwrap_or_else(|| PathBuf::from(&home).join(".codex"))),
        // kimi 등은 아직 credential 파일 규약이 없다 — 빈 정체성
        _ => identity(LoginStatus::Unknown),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encode_payload(json: &serde_json::Value) -> String {
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json.to_string())
    }

    #[test]
    fn claude_reads_oauth_account_email_only() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(".claude.json"),
            r#"{"oauthAccount":{"emailAddress":"me@example.com","accountUuid":"u-1"},"apiKey":"sk-secret"}"#,
        )
        .unwrap();
        let identity = claude_identity_at(dir.path(), LoginStatus::Authenticated);
        assert_eq!(identity.status, LoginStatus::Authenticated);
        assert_eq!(identity.email.as_deref(), Some("me@example.com"));
        assert_eq!(identity.plan, None);
    }

    #[test]
    fn claude_identity_metadata_does_not_override_credential_status() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            claude_identity_at(dir.path(), LoginStatus::Unauthenticated),
            identity(LoginStatus::Unauthenticated),
        );
        std::fs::write(
            dir.path().join(".claude.json"),
            r#"{"oauthAccount":{"emailAddress":"stale@example.com"}}"#,
        )
        .unwrap();
        let logged_out = claude_identity_at(dir.path(), LoginStatus::Unauthenticated);
        assert_eq!(logged_out.status, LoginStatus::Unauthenticated);
        assert_eq!(logged_out.email.as_deref(), Some("stale@example.com"));
        std::fs::write(dir.path().join(".claude.json"), "not-json").unwrap();
        assert_eq!(
            claude_identity_at(dir.path(), LoginStatus::Unknown),
            identity(LoginStatus::Unknown),
        );
    }

    #[test]
    fn file_credentials_distinguish_absent_empty_and_present() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("credential.json");
        assert_eq!(
            file_credential_status(&path),
            LoginStatus::Unauthenticated,
        );
        std::fs::write(&path, "").unwrap();
        assert_eq!(file_credential_status(&path), LoginStatus::Unknown);
        std::fs::write(&path, "credential").unwrap();
        assert_eq!(file_credential_status(&path), LoginStatus::Authenticated);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn claude_scoped_keychain_service_uses_the_exact_config_root_hash() {
        assert_eq!(
            claude_keychain_service(None),
            "Claude Code-credentials",
        );
        assert_eq!(
            claude_keychain_service(Some("/tmp/claude-work")),
            "Claude Code-credentials-bfc1769a",
        );
    }

    #[test]
    fn codex_reads_email_and_plan_from_id_token_payload() {
        let dir = tempfile::tempdir().unwrap();
        let payload = encode_payload(&serde_json::json!({
            "email": "dev@example.com",
            "https://api.openai.com/auth": { "chatgpt_plan_type": "pro" },
        }));
        std::fs::write(
            dir.path().join("auth.json"),
            format!(r#"{{"tokens":{{"id_token":"e30.{payload}.sig","access_token":"secret"}}}}"#),
        )
        .unwrap();
        let identity = codex_identity_at(dir.path());
        assert_eq!(identity.email.as_deref(), Some("dev@example.com"));
        assert_eq!(identity.plan.as_deref(), Some("pro"));
    }

    #[test]
    fn codex_profile_claim_is_the_email_fallback() {
        let dir = tempfile::tempdir().unwrap();
        let payload = encode_payload(&serde_json::json!({
            "https://api.openai.com/profile": { "email": "profile@example.com" },
        }));
        std::fs::write(
            dir.path().join("auth.json"),
            format!(r#"{{"tokens":{{"id_token":"e30.{payload}.sig"}}}}"#),
        )
        .unwrap();
        assert_eq!(
            codex_identity_at(dir.path()).email.as_deref(),
            Some("profile@example.com"),
        );
    }

    #[test]
    fn codex_api_key_login_is_authenticated_without_identity() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("auth.json"), r#"{"OPENAI_API_KEY":"sk-x"}"#).unwrap();
        assert_eq!(
            codex_identity_at(dir.path()),
            identity(LoginStatus::Authenticated),
        );
    }

    #[test]
    fn codex_missing_credentials_are_unauthenticated() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            codex_identity_at(dir.path()),
            identity(LoginStatus::Unauthenticated),
        );
    }
}
