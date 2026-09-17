//! The server inventory the laptop distributes keys to.
//!
//! **There is no second source of truth here.** The desktop app's Zustand store
//! owns `sshHosts`; it lives in the app's WebKit `localStorage`, which is not a
//! surface another process can read safely (SQLite plus a WAL, rewritten under
//! us while the app runs). The repository already solved exactly this problem
//! once: the desktop app mirrors the store to its channel-scoped
//! `agents.json` on every store change so the external CLI can reach agents. This
//! reads the `sshHosts` array from that same, already-wired mirror — one
//! writer, one authority, a file that is a projection rather than a copy an
//! operator is expected to maintain.
//!
//! What the mirror deliberately does not carry: secrets. `secretId` and the
//! legacy `password` field stay in the store and the OS credential store. This
//! Manually entered rows export the coordinates and key path system ssh needs.
//! Imported rows additionally export their opaque config alias; their direct
//! fields are the endpoint projection the phone stores, while OpenSSH alone
//! resolves routing and authentication from the alias.
//!
//! A missing or pre-`sshHosts` mirror is an error, not an empty list. Reporting
//! zero configured servers when the truth is "we could not read them" would
//! hand the phone a short inventory that reads as complete, which is the same
//! failure mode as silently dropping a host that failed to install.

use crate::CliError;
use serde::Deserialize;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};

/// Overrides where the desktop app's export is read from. Set by the tests, and
/// by anyone running a non-default app channel layout by hand.
pub(crate) const INVENTORY_PATH_ENV: &str = "HMUX_PAIRING_INVENTORY";

/// Selects the desktop app's control-directory channel, mirroring
/// `src-tauri/src/app_channel.rs`.
const APP_CHANNEL_ENV: &str = "DURE_APP_CHANNEL";
const LEGACY_APP_CHANNEL_ENV: &str = "HEBBIAN_APP_CHANNEL";
const STABLE_CHANNEL: &str = "stable";

/// Which machine a host row denotes.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum HostTarget {
    /// This laptop. Installed in-process; there is no ssh hop to itself.
    ThisLaptop,
    /// A configured server, reached over ssh.
    Remote(SshInvocation),
}

/// The one authority system ssh uses to resolve a remote server.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum SshInvocation {
    /// A host entered manually. Its stored user/address/port/key are explicit.
    Explicit,
    /// A host imported from SSH config. OpenSSH owns all routing and auth
    /// semantics behind this opaque destination, including ProxyJump/Match.
    ConfigAlias(String),
}

#[derive(Clone, Debug)]
pub(crate) struct InventoryHost {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) user: String,
    /// `auto` | `password` | `key`, as the desktop app records it.
    pub(crate) auth: String,
    pub(crate) key_path: Option<String>,
    pub(crate) target: HostTarget,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportedRegistry {
    #[serde(default)]
    ssh_hosts: Option<Vec<ExportedHost>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportedHost {
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    ssh_config_alias: Option<String>,
    host: String,
    port: u16,
    user: String,
    #[serde(default)]
    auth: Option<String>,
    #[serde(default)]
    key_path: Option<String>,
}

/// Resolves the desktop app export path.
pub(crate) fn default_inventory_path() -> Result<PathBuf, CliError> {
    if let Some(explicit) = std::env::var_os(INVENTORY_PATH_ENV) {
        return Ok(PathBuf::from(explicit));
    }
    let home = dirs::home_dir();
    let canonical = std::env::var_os(APP_CHANNEL_ENV);
    let legacy = std::env::var_os(LEGACY_APP_CHANNEL_ENV);
    let channel = resolve_app_channel(canonical.as_deref(), legacy.as_deref())?;
    let candidates = inventory_path_candidates(
        home.as_deref(),
        std::env::var_os("DURE_HOME").as_deref(),
        &channel,
    )?;
    Ok(select_inventory_path(&candidates))
}

fn inventory_path_candidates(
    home: Option<&Path>,
    dure_home: Option<&OsStr>,
    channel: &str,
) -> Result<Vec<PathBuf>, CliError> {
    let inventory_below = |root: PathBuf| {
        if channel == STABLE_CHANNEL {
            root.join("agents.json")
        } else {
            root.join("channels").join(channel).join("agents.json")
        }
    };
    if let Some(root) = dure_home.filter(|value| !value.is_empty()) {
        return Ok(vec![inventory_below(PathBuf::from(root))]);
    }
    let home = home.ok_or_else(|| {
        CliError("pairing could not resolve a home directory to read the host inventory".into())
    })?;
    Ok(vec![
        inventory_below(home.join(".dure")),
        inventory_below(home.join(".hebbian")),
    ])
}

fn select_inventory_path(candidates: &[PathBuf]) -> PathBuf {
    candidates
        .iter()
        .find(|candidate| candidate.exists())
        .unwrap_or_else(|| {
            candidates
                .first()
                .expect("inventory candidates always carry a canonical path")
        })
        .clone()
}

fn resolve_app_channel(
    canonical: Option<&OsStr>,
    legacy: Option<&OsStr>,
) -> Result<String, CliError> {
    let Some(value) = canonical.or(legacy) else {
        return Ok(STABLE_CHANNEL.into());
    };
    let value = value
        .to_str()
        .ok_or_else(|| CliError(format!("{APP_CHANNEL_ENV} must be a UTF-8 app channel")))?;
    if value.is_empty()
        || value.len() > 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return Err(CliError(format!(
            "{APP_CHANNEL_ENV} must be a lowercase filesystem-safe token"
        )));
    }
    Ok(value.into())
}

/// Reads every SSH host the desktop app has configured.
pub(crate) fn load_configured_hosts(path: &Path) -> Result<Vec<InventoryHost>, CliError> {
    let raw = std::fs::read(path).map_err(|error| {
        CliError(format!(
            "pairing could not read the desktop app's host inventory at {}: {error}\n\
             Start the desktop app once so it writes the inventory, or point \
             {INVENTORY_PATH_ENV} at it.",
            path.display()
        ))
    })?;
    let registry: ExportedRegistry = serde_json::from_slice(&raw).map_err(|error| {
        CliError(format!(
            "pairing could not parse the desktop app's host inventory at {}: {error}",
            path.display()
        ))
    })?;
    // `None` and `Some(vec![])` are different facts: the first is an app build
    // that predates this export and whose real host list is unknown; the second
    // is an owner with no servers configured. Only the second may proceed.
    let hosts = registry.ssh_hosts.ok_or_else(|| {
        CliError(format!(
            "the desktop app's inventory at {} carries no sshHosts array — it was \
             written by an app build that predates pairing. Update and relaunch \
             the desktop app; pairing refuses to distribute keys to a host list \
             it cannot see.",
            path.display()
        ))
    })?;
    hosts
        .into_iter()
        .map(|host| {
            if host.host.trim().is_empty() || host.user.trim().is_empty() {
                return Err(CliError(format!(
                    "the desktop app's inventory lists host '{}' with no address or user",
                    host.id
                )));
            }
            let invocation = host
                .ssh_config_alias
                .and_then(|alias| {
                    let alias = alias.trim();
                    (!alias.is_empty()).then(|| alias.to_owned())
                })
                .map_or(SshInvocation::Explicit, SshInvocation::ConfigAlias);
            Ok(InventoryHost {
                name: if host.name.trim().is_empty() {
                    host.host.clone()
                } else {
                    host.name
                },
                id: host.id,
                host: host.host,
                port: host.port,
                user: host.user,
                auth: host.auth.unwrap_or_else(|| "auto".into()),
                key_path: host.key_path.filter(|path| !path.trim().is_empty()),
                target: HostTarget::Remote(invocation),
            })
        })
        .collect()
}

/// The laptop's own row. Present in every inventory: the owner's own machine is
/// a server the phone must be able to reach once the lid is open again.
pub(crate) fn this_laptop(address: &str, port: u16, user: String) -> InventoryHost {
    InventoryHost {
        id: "this-laptop".into(),
        name: "this laptop".into(),
        host: address.to_string(),
        port,
        user,
        auth: "auto".into(),
        key_path: None,
        target: HostTarget::ThisLaptop,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dure_channel_is_authoritative_and_hebbian_is_only_a_fallback() {
        assert_eq!(
            resolve_app_channel(
                Some(OsStr::new("dev-canonical-a1b2c3d4")),
                Some(OsStr::new("dev-legacy-decoy-a1b2c3d4")),
            )
            .unwrap(),
            "dev-canonical-a1b2c3d4"
        );
        assert_eq!(
            resolve_app_channel(None, Some(OsStr::new("dev-legacy-a1b2c3d4"))).unwrap(),
            "dev-legacy-a1b2c3d4"
        );
        assert!(
            resolve_app_channel(
                Some(OsStr::new("../invalid")),
                Some(OsStr::new("dev-legacy-a1b2c3d4")),
            )
            .is_err()
        );
    }

    #[test]
    fn inventory_candidates_use_dure_home_as_the_only_explicit_authority() {
        assert_eq!(
            inventory_path_candidates(
                Some(Path::new("/home/tester")),
                Some(OsStr::new("/portable/dure")),
                "dev-a1b2c3d4",
            )
            .unwrap(),
            vec![PathBuf::from(
                "/portable/dure/channels/dev-a1b2c3d4/agents.json"
            )]
        );
    }

    #[test]
    fn explicit_dure_home_does_not_require_a_system_home() {
        assert_eq!(
            inventory_path_candidates(None, Some(OsStr::new("/portable/dure")), STABLE_CHANNEL)
                .unwrap(),
            vec![PathBuf::from("/portable/dure/agents.json")]
        );
    }

    #[test]
    fn canonical_inventory_wins_and_legacy_is_only_an_absence_fallback() {
        let directory = tempfile::tempdir().unwrap();
        let canonical = directory.path().join(".dure/agents.json");
        let legacy = directory.path().join(".hebbian/agents.json");
        std::fs::create_dir_all(canonical.parent().unwrap()).unwrap();
        std::fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        std::fs::write(&canonical, "{").unwrap();
        std::fs::write(&legacy, r#"{"version":3,"sshHosts":[]}"#).unwrap();
        let candidates =
            inventory_path_candidates(Some(directory.path()), None, STABLE_CHANNEL).unwrap();

        let selected = select_inventory_path(&candidates);
        assert_eq!(selected, canonical);
        assert!(load_configured_hosts(&selected).is_err());

        std::fs::remove_file(&canonical).unwrap();
        assert_eq!(select_inventory_path(&candidates), legacy);
        assert!(load_configured_hosts(&legacy).unwrap().is_empty());
    }

    fn write(contents: &str) -> (tempfile::TempDir, PathBuf) {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("agents.json");
        std::fs::write(&path, contents).unwrap();
        (directory, path)
    }

    #[test]
    fn hosts_are_read_from_the_desktop_apps_existing_mirror() {
        let (_directory, path) = write(
            r#"{"version":3,"agents":[],"sshHosts":[
                {"id":"a","name":"build box","host":"10.0.0.4","port":2222,
                 "user":"kattpish","auth":"key","keyPath":"~/.ssh/id_ed25519",
                 "sshConfigAlias":"  build-via-bastion  "}]}"#,
        );
        let hosts = load_configured_hosts(&path).unwrap();
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].port, 2222);
        assert_eq!(hosts[0].key_path.as_deref(), Some("~/.ssh/id_ed25519"));
        assert_eq!(
            hosts[0].target,
            HostTarget::Remote(SshInvocation::ConfigAlias("build-via-bastion".into()))
        );
    }

    #[test]
    fn a_blank_config_alias_normalizes_to_an_explicit_route() {
        let (_directory, path) = write(
            r#"{"version":3,"sshHosts":[
                {"id":"a","name":"manual","host":"10.0.0.4","port":22,
                 "user":"kattpish","auth":"auto","sshConfigAlias":"   "}]}"#,
        );

        let hosts = load_configured_hosts(&path).unwrap();

        assert_eq!(hosts[0].target, HostTarget::Remote(SshInvocation::Explicit));
    }

    #[test]
    fn an_inventory_without_ssh_hosts_is_refused_rather_than_read_as_empty() {
        let (_directory, path) = write(r#"{"version":2,"agents":[],"projects":[]}"#);
        let error = load_configured_hosts(&path).unwrap_err();
        assert!(error.0.contains("predates pairing"), "{}", error.0);
    }

    #[test]
    fn an_owner_with_no_servers_configured_is_allowed_through() {
        let (_directory, path) = write(r#"{"version":3,"sshHosts":[]}"#);
        assert!(load_configured_hosts(&path).unwrap().is_empty());
    }

    #[test]
    fn a_missing_inventory_names_the_path_it_looked_at() {
        let error = load_configured_hosts(Path::new("/nonexistent/agents.json")).unwrap_err();
        assert!(error.0.contains("/nonexistent/agents.json"), "{}", error.0);
    }
}
