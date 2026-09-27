//! Thin Tauri wrappers around the shared native provider-profile adapter.

pub use dure_provider_profile::create_account_profile_directory_at_app_root;
pub(crate) use dure_provider_profile::{
    codex_overlay_wiring, provider_default_state_environment, resolve_account_profile_directory,
    resolve_codex_canonical_state_directory, reviewed_overlay_policy, CodexOverlayWiring,
};

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
    read_profile_credential_using(
        provider,
        home,
        account_dir,
        #[cfg(target_os = "macos")]
        crate::login_identity::read_claude_keychain_credential,
    )
}

fn read_profile_credential_using(
    provider: &str,
    home: &str,
    account_dir: &str,
    #[cfg(target_os = "macos")] read_keychain: impl FnOnce(&str) -> Result<Option<Vec<u8>>, String>,
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
        if let Some(bytes) = read_keychain(config_root)? {
            return Ok((
                reviewed_overlay_policy(provider)?
                    .credential_file_name
                    .to_string(),
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
    use hebbian_bounded_process::{CommandOutput, CommandSpec};
    use std::time::Duration;

    fn security(arguments: &[&str]) -> CommandOutput {
        let mut command = CommandSpec::new("/usr/bin/security");
        command.args(arguments).capture_stderr(true);
        hebbian_bounded_process::run(&command, Duration::from_secs(10), 4 * 1024 * 1024)
            .expect("the private keychain fixture must finish without user interaction")
    }

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
        // A keychain outside Library/Keychains is private: create never adds it
        // to the user's search list. Every write and lookup names this file.
        let keychain = home.join("transfer.keychain");
        let keychain_path = keychain.to_str().unwrap();
        let search_before = security(&["list-keychains", "-d", "user"]);
        let default_before = security(&["default-keychain", "-d", "user"]);
        assert!(
            security(&["create-keychain", "-p", "disposable-fixture", keychain_path])
                .status
                .success()
        );
        assert!(security(&[
            "add-generic-password",
            "-s",
            &service,
            "-a",
            "dure-transfer-test",
            "-w",
            fixture,
            keychain_path,
        ])
        .status
        .success());
        let read_keychain = |root: &str| {
            crate::login_identity::read_claude_keychain_credential_from(root, Some(&keychain))
        };
        let result = read_profile_credential_using(
            "claude",
            home.to_str().unwrap(),
            config_root,
            read_keychain,
        );
        let sibling_result = read_profile_credential_using(
            "claude",
            home.to_str().unwrap(),
            sibling.to_str().unwrap(),
            read_keychain,
        );
        let invalid_result = read_profile_credential_using(
            "claude",
            home.to_str().unwrap(),
            home.to_str().unwrap(),
            read_keychain,
        );
        let search_after = security(&["list-keychains", "-d", "user"]);
        let default_after = security(&["default-keychain", "-d", "user"]);
        assert_eq!(search_after.status, search_before.status);
        assert_eq!(search_after.stdout, search_before.stdout);
        assert_eq!(default_after.status, default_before.status);
        assert_eq!(default_after.stdout, default_before.stdout);
        let (name, bytes) = result.unwrap();
        assert_eq!(name, ".credentials.json");
        assert_eq!(String::from_utf8(bytes).unwrap().trim(), fixture);
        assert!(!directory.join(".credentials.json").exists());
        assert!(sibling_result
            .unwrap_err()
            .starts_with("credential_transfer_unavailable:"));
        assert!(invalid_result
            .unwrap_err()
            .starts_with("credential_directory_untrusted:"));
    }
}
