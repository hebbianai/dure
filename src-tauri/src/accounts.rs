//! Thin Tauri wrappers around the shared native provider-profile adapter.

pub(crate) use dure_provider_profile::{
    CodexOverlayWiring, codex_overlay_wiring, provider_default_state_environment,
    resolve_account_profile_directory, resolve_codex_canonical_state_directory,
    reviewed_overlay_policy,
};
pub use dure_provider_profile::create_account_profile_directory_at_app_root;

pub fn prepare_managed_provider_profile(
    provider: &str,
    home: &str,
    credential_id: Option<&str>,
    credential_directory: Option<&str>,
) -> Result<hmux_client::ProviderStateEnvironment, String> {
    dure_provider_profile::prepare_managed_provider_profile_with_codex_notify(
        provider,
        home,
        credential_id,
        credential_directory,
        crate::managed_hooks::codex_notify_command().as_deref(),
    )
}

pub(crate) fn read_profile_credential(
    provider: &str,
    home: &str,
    account_dir: &str,
) -> Result<(String, Vec<u8>), String> {
    #[cfg(target_os = "macos")]
    if provider == "claude" {
        let directory = resolve_account_profile_directory(
            provider,
            home,
            "remote-credential-transfer",
            account_dir,
        )?;
        let config_root = directory.to_str().ok_or_else(|| {
            "credential_directory_untrusted: profile path must be UTF-8".to_string()
        })?;
        if let Some(bytes) = crate::login_identity::read_claude_keychain_credential(config_root)? {
            return Ok((
                reviewed_overlay_policy(provider)?.credential_file_name.to_string(),
                bytes,
            ));
        }
    }
    dure_provider_profile::read_profile_credential_with_codex_notify(
        provider,
        home,
        account_dir,
        crate::managed_hooks::codex_notify_command().as_deref(),
    )
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};

    #[test]
    fn transfers_only_the_selected_claude_keychain_profile_without_a_credential_file() {
        let home = tempfile::tempdir().unwrap();
        let home = home.path().canonicalize().unwrap();
        let directory = home.join(".dure/accounts/claude-transfer-test");
        std::fs::create_dir_all(&directory).unwrap();
        let sibling = home.join(".dure/accounts/claude-sibling");
        std::fs::create_dir(&sibling).unwrap();
        let config_root = directory.to_str().unwrap();
        let service = crate::login_identity::claude_keychain_service(Some(config_root));
        let fixture = r#"{"claudeAiOauth":{"accessToken":"disposable-ssh-transfer-fixture"}}"#;
        assert!(Command::new("/usr/bin/security")
            .args([
                "add-generic-password", "-s", &service, "-a", "dure-transfer-test", "-w", fixture,
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status().unwrap().success());

        let result = read_profile_credential("claude", home.to_str().unwrap(), config_root);
        let sibling_result = read_profile_credential(
            "claude", home.to_str().unwrap(), sibling.to_str().unwrap(),
        );
        let invalid_result = read_profile_credential(
            "claude", home.to_str().unwrap(), home.to_str().unwrap(),
        );
        // Remove only this disposable entry before assertions can fail.
        let removed = Command::new("/usr/bin/security")
            .args(["delete-generic-password", "-s", &service, "-a", "dure-transfer-test"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status().unwrap();
        assert!(removed.success());
        let (name, bytes) = result.unwrap();
        assert_eq!(name, ".credentials.json");
        assert_eq!(String::from_utf8(bytes).unwrap().trim(), fixture);
        assert!(!directory.join(".credentials.json").exists());
        assert!(sibling_result.unwrap_err().starts_with("credential_transfer_unavailable:"));
        assert!(invalid_result.unwrap_err().starts_with("credential_directory_untrusted:"));
    }
}
