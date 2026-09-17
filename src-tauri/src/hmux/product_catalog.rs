use hmux_client::LocalSessionCatalog;
use std::path::PathBuf;

/// Resolve the one product catalog authority owned by `hmux-client`.
///
/// The client keeps a canonical mutable Dure root plus bounded legacy roots
/// used only for discovery and attach. The desktop adapter must not reproduce
/// that policy or turn a legacy compatibility input back into a write root.
/// Product runtime brokers likewise inherit this environment; passing only
/// `catalog.discovery_root()` as `HMUX_DISCOVERY_ROOT` would flatten the plan
/// and silently discard those read-only compatibility roots.
pub(super) fn product_catalog() -> Result<LocalSessionCatalog, hmux_client::ClientError> {
    LocalSessionCatalog::from_environment()
}

/// 설정 › 데이터 위치용 — 지금 앱이 쓰는 canonical discovery root 경로.
pub(crate) fn product_discovery_root_path() -> Option<PathBuf> {
    product_catalog()
        .ok()
        .map(|catalog| catalog.discovery_root().to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    const PRODUCT_CATALOG_PATH_OUTPUT_ENV: &str = "DURE_TEST_PRODUCT_CATALOG_PATH_OUTPUT";

    #[test]
    #[ignore = "launched in an isolated process by product_catalog_uses_dure_home_authority"]
    fn product_catalog_path_child_helper() {
        let output = std::env::var_os(PRODUCT_CATALOG_PATH_OUTPUT_ENV)
            .expect("product catalog path output must be configured");
        let catalog =
            product_catalog().expect("product catalog must resolve in the isolated child");
        let root = catalog.discovery_root();
        super::super::recovery::reserve(
            root,
            super::super::recovery::RecoveryIdentity {
                recovery_id: "catalog-authority-test".into(),
                source_session_id: "source-session".into(),
                source_workspace_id: "source-workspace".into(),
                request_fingerprint: "a".repeat(64),
                action: "verify_product_catalog_authority",
            },
        )
        .expect("product recovery reservation must use the resolved catalog");
        std::fs::write(output, root.as_os_str().as_encoded_bytes())
            .expect("product catalog path must be published");
    }

    #[test]
    fn product_catalog_uses_dure_home_authority() {
        let fixture = tempfile::tempdir().unwrap();
        let canonical = fixture.path().join("canonical-dure-home");
        let legacy = fixture.path().join("legacy-hebbian-home");
        let output = fixture.path().join("catalog-path");
        let canonical_discovery = canonical.join("state/hmux-hosts");
        std::fs::create_dir_all(&canonical_discovery).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&canonical_discovery, std::fs::Permissions::from_mode(0o700))
                .unwrap();
        }
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .arg("--exact")
            .arg("hmux::product_catalog::tests::product_catalog_path_child_helper")
            .arg("--ignored")
            .env_remove(hmux_client::DISCOVERY_ROOT_ENV)
            .env("DURE_HOME", &canonical)
            .env("HEBBIAN_HOME", &legacy)
            .env(PRODUCT_CATALOG_PATH_OUTPUT_ENV, &output)
            .status()
            .unwrap();
        assert!(status.success());
        assert_eq!(
            std::fs::read(&output).unwrap(),
            canonical
                .join("state/hmux-hosts")
                .as_os_str()
                .as_encoded_bytes()
        );
        assert!(canonical_discovery.join(".recovery").is_dir());
        assert!(!legacy.join("state/hebbian-agent/hmux-hosts").exists());
    }
}
