use dure_session_runtime::host_command::{HELPER_NAME, HELPER_OPERATIONS, HELPER_PROTOCOL};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::path::Path;
use tauri::Manager;

const MAX_HELPER_BYTES: u64 = 64 * 1024 * 1024;
const MAX_CAPABILITIES_BYTES: usize = 4 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HelperResponse {
    schema_version: u8,
    value: HelperCapabilities,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct HelperCapabilities {
    protocol: String,
    operations: Vec<String>,
}

fn unavailable(detail: impl std::fmt::Display) -> String {
    format!("remote_git_checkout_capability_unavailable: {detail}")
}

fn read_bundled_helper(path: &Path) -> Result<Vec<u8>, String> {
    let metadata = std::fs::symlink_metadata(path).map_err(unavailable)?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() == 0
        || metadata.len() > MAX_HELPER_BYTES
    {
        return Err(unavailable("bundled helper is not a bounded regular file"));
    }
    std::fs::read(path).map_err(unavailable)
}

fn bundled_helper<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    triple: &str,
) -> Result<(Vec<u8>, String), String> {
    let resource_dir = app.path().resource_dir().map_err(unavailable)?;
    let bytes = read_bundled_helper(
        &resource_dir
            .join("resources/remote-git-checkout-helper")
            .join(triple)
            .join(HELPER_NAME),
    )?;
    let digest = format!("{:x}", Sha256::digest(&bytes));
    Ok((bytes, digest))
}

fn validate_capabilities(result: &crate::ssh::ExecResult) -> Result<(), String> {
    if result.code != 0
        || result.stdout.is_empty()
        || result.stdout.len() > MAX_CAPABILITIES_BYTES
        || !result.stderr.is_empty()
    {
        return Err(unavailable("helper capability probe failed"));
    }
    let response: HelperResponse = serde_json::from_str(&result.stdout).map_err(unavailable)?;
    let expected = HELPER_OPERATIONS;
    if response.schema_version != 1
        || response.value.protocol != HELPER_PROTOCOL
        || response.value.operations.len() != expected.len()
        || !response
            .value
            .operations
            .iter()
            .zip(expected)
            .all(|(actual, expected)| actual == expected)
    {
        return Err(unavailable("helper capability contract is incompatible"));
    }
    Ok(())
}

fn prepare_upload(session: &ssh2::Session) -> Result<String, String> {
    let result = crate::ssh::exec_on(
        session,
        "set -eu; umask 077; helper_root=\"$HOME/.local/share/dure/remote-tools/dure-git-checkout-helper\"; mkdir -p \"$helper_root\"; chmod 700 \"$helper_root\"; helper_upload=$(mktemp \"$helper_root/.upload.XXXXXX\"); printf 'staging=%s\\n' \"$helper_upload\"",
    )
    .map_err(unavailable)?;
    if result.code != 0 {
        return Err(unavailable(result.stderr.trim()));
    }
    let staging = result
        .stdout
        .lines()
        .find_map(|line| line.strip_prefix("staging="))
        .unwrap_or_default();
    let Some((root, suffix)) = staging.rsplit_once("/.upload.") else {
        return Err(unavailable("remote staging path is invalid"));
    };
    if !root.starts_with('/')
        || suffix.len() != 6
        || !suffix.bytes().all(|byte| byte.is_ascii_alphanumeric())
    {
        return Err(unavailable("remote staging path is invalid"));
    }
    Ok(staging.to_string())
}

fn exact_path(staging: &str, digest: &str) -> Result<String, String> {
    let (root, _) = staging
        .rsplit_once("/.upload.")
        .ok_or_else(|| unavailable("remote staging path is invalid"))?;
    Ok(format!("{root}/{digest}"))
}

fn cleanup(session: &ssh2::Session, staging: &str) {
    let _ = crate::ssh::exec_on(
        session,
        &format!("rm -f -- {}", crate::ssh::shell_quote(staging)),
    );
}

fn ensure_inner(
    session: &ssh2::Session,
    bytes: &[u8],
    digest: &str,
) -> Result<String, String> {
    let staging = prepare_upload(session)?;
    let result = (|| {
        crate::ssh::upload_on(session, &staging, bytes).map_err(unavailable)?;
        let staged_probe = crate::ssh::exec_on(
            session,
            &format!(
                "chmod 700 {staging} && {staging} capabilities-v1",
                staging = crate::ssh::shell_quote(&staging),
            ),
        )
        .map_err(unavailable)?;
        validate_capabilities(&staged_probe)?;

        let exact = exact_path(&staging, digest)?;
        let activation = crate::ssh::exec_on(
            session,
            &format!(
                "set -eu; staging={staging}; exact={exact}; if [ -L \"$exact\" ] || {{ [ -e \"$exact\" ] && [ ! -f \"$exact\" ]; }}; then exit 1; fi; if [ ! -e \"$exact\" ]; then ln \"$staging\" \"$exact\" 2>/dev/null || true; fi; [ ! -L \"$exact\" ] && [ -f \"$exact\" ] && [ -x \"$exact\" ] && cmp -s \"$staging\" \"$exact\"; rm -f \"$staging\"",
                staging = crate::ssh::shell_quote(&staging),
                exact = crate::ssh::shell_quote(&exact),
            ),
        )
        .map_err(unavailable)?;
        if activation.code != 0 {
            return Err(unavailable("could not activate the exact helper build"));
        }
        let exact_probe = crate::ssh::exec_on(
            session,
            &format!(
                "{} capabilities-v1",
                crate::ssh::shell_quote(&exact)
            ),
        )
        .map_err(unavailable)?;
        validate_capabilities(&exact_probe)?;
        Ok(exact)
    })();
    if result.is_err() {
        cleanup(session, &staging);
    }
    result
}

fn ensure(app: &tauri::AppHandle, opts: &crate::ssh::SshOptions) -> Result<String, String> {
    let session = crate::ssh::acquire(opts).map_err(unavailable)?;
    ensure_on(app, &session)
}

/// Provision and execute within the caller's one-shot SSH connection. No
/// global connection pool or resident helper is needed across requests.
pub(crate) fn ensure_on<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    session: &ssh2::Session,
) -> Result<String, String> {
    let triple = crate::remote_platform::detect_linux_triple_on(session).map_err(|error| match error {
        crate::remote_platform::RemotePlatformError::Probe(detail) => unavailable(detail),
        crate::remote_platform::RemotePlatformError::Unsupported { system, machine } => {
            unavailable(format!("unsupported remote platform {system} {machine}"))
        }
    })?;
    let (bytes, digest) = bundled_helper(app, triple)?;
    ensure_inner(session, &bytes, &digest)
}

#[tauri::command(async)]
pub(crate) async fn prepare_remote_git_checkout_helper(
    app: tauri::AppHandle,
    opts: crate::ssh::SshOptions,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || ensure(&app, &opts))
        .await
        .map_err(|error| unavailable(format!("provision task failed: {error}")))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_the_exact_capability_contract() {
        let exact = crate::ssh::ExecResult {
            code: 0,
            stderr: String::new(),
            stdout: serde_json::json!({
                "schemaVersion": 1,
                "value": {"protocol": HELPER_PROTOCOL, "operations": HELPER_OPERATIONS}
            }).to_string(),
        };
        assert!(validate_capabilities(&exact).is_ok());
        assert!(validate_capabilities(&crate::ssh::ExecResult {
            // The pre-reconciliation helper advertised every operation but could not
            // decode ReconcileManagedClose. It must fail admission before use.
            stdout: exact.stdout.replace(HELPER_PROTOCOL, "dure-git-checkout-helper-v1"),
            ..exact
        })
        .is_err());
    }

    #[test]
    fn derives_one_content_address_beside_the_private_upload() {
        assert_eq!(
            exact_path(
                "/home/dev/.local/share/dure/remote-tools/dure-git-checkout-helper/.upload.A1b2C3",
                "0123456789abcdef"
            )
            .unwrap(),
            "/home/dev/.local/share/dure/remote-tools/dure-git-checkout-helper/0123456789abcdef"
        );
    }
}
