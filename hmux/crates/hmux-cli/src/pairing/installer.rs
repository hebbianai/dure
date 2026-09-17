//! Getting one `authorized_keys` line onto every configured server.
//!
//! # One implementation of the dangerous part, not two
//!
//! The obvious shape — build a shell script and pipe it into `ssh` — would put
//! a *second* implementation of the append rules (trailing newline, atomic
//! rename, mode preservation) into `sh`, where none of this crate's tests can
//! reach it. The failure that guard exists to prevent would then be prevented
//! only on the laptop.
//!
//! So the remote side runs the same Rust: `hmux pair apply-authorized-key`
//! reads one JSON request on stdin and applies it locally, and the laptop
//! invokes it over `ssh`. `scripts/provision-hmux-remote.mjs` already exists to
//! put `hmux` on a server that has none, so "no hmux there" is a solvable
//! state — and when it is not yet solved, that server is *named as failed*
//! rather than dropped.
//!
//! # Authentication
//!
//! `src-tauri/src/ssh.rs` authenticates with a four-rung ladder — none-auth
//! (Tailscale SSH), ssh-agent, the default `~/.ssh/id_*` keys, or an explicit
//! key file — through `ssh2`/libssh2. That code cannot be called from here:
//! it lives in the Tauri app crate, in a different Cargo workspace, behind
//! `tauri` and the macOS Keychain. Reimplementing the ladder against `russh`
//! would be a *new* auth path with its own bugs, which the brief rules out.
//!
//! What is reused instead is the ladder itself, by delegating to the system
//! `ssh` binary, which implements the same rungs natively (`none`, agent,
//! `IdentityFile`, `~/.ssh/config`) and is already how
//! `scripts/provision-hmux-remote.mjs` reaches this same fleet. OpenSSH is the
//! sole authentication authority here. `BatchMode=yes` makes a
//! route that would require an interactive password fail without introducing a
//! second preflight interpretation of the desktop credential state.

use super::authorized_keys::{AppliedChange, AuthorizedKeysFile};
use super::inventory::{HostTarget, InventoryHost};
use super::system_ssh::SystemSsh;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::Instant;

/// Where `scripts/provision-hmux-remote.mjs` installs hmux. Quoted so a home
/// directory with a space survives the remote shell.
pub(crate) const DEFAULT_REMOTE_HMUX: &str = "\"$HOME/.local/bin/hmux\"";

/// Request handed to `hmux pair apply-authorized-key` on stdin.
#[derive(Debug, Deserialize, Serialize)]
pub(crate) struct ApplyRequest {
    pub(crate) version: u32,
    /// The exact `authorized_keys` line to append.
    pub(crate) entry: String,
}

/// What the remote (or local) applier reports back.
#[derive(Debug, Deserialize, Serialize)]
pub(crate) struct ApplyReceipt {
    pub(crate) version: u32,
    pub(crate) installed: bool,
    pub(crate) already_present: bool,
    pub(crate) authorized_keys_path: String,
}

#[derive(Serialize)]
struct WireApplyReceipt<'a> {
    #[serde(flatten)]
    receipt: &'a ApplyReceipt,
    /// Kept only so older controllers can read a v1 receipt. Current endpoint
    /// identity comes from the authenticated OpenSSH process before mutation.
    host_key_fingerprint: Option<&'a str>,
}

pub(crate) const APPLY_PROTOCOL_VERSION: u32 = 1;

/// Applies an entry to this machine's `authorized_keys`.
///
/// Shared by the laptop's own row and by every remote invocation, which is the
/// whole point: the byte rules are implemented and tested exactly once.
pub(crate) fn apply_locally(home: &std::path::Path, entry: &str) -> Result<ApplyReceipt, String> {
    let file = AuthorizedKeysFile::in_home(home);
    let change = file
        .append(entry)
        .map_err(|error| format!("could not update {}: {error}", file.path().display()))?;
    Ok(ApplyReceipt {
        version: APPLY_PROTOCOL_VERSION,
        installed: true,
        already_present: change == AppliedChange::AlreadyPresent,
        authorized_keys_path: file.path().display().to_string(),
    })
}

pub(crate) fn serialize_wire_receipt(
    receipt: &ApplyReceipt,
    legacy_host_key_fingerprint: Option<&str>,
) -> Result<String, serde_json::Error> {
    serde_json::to_string(&WireApplyReceipt {
        receipt,
        host_key_fingerprint: legacy_host_key_fingerprint,
    })
}

/// Removes an entry from this machine's `authorized_keys`.
pub(crate) fn revoke_locally(home: &std::path::Path, entry: &str) -> Result<bool, String> {
    let file = AuthorizedKeysFile::in_home(home);
    file.remove(entry)
        .map(|change| change == AppliedChange::Written)
        .map_err(|error| format!("could not update {}: {error}", file.path().display()))
}

/// Reaches one server and applies (or removes) the entry there.
pub(crate) trait AuthorizedKeyInstaller {
    /// Calls `before_mutation` with the exact endpoint pin while the mutation
    /// process is authenticated but still blocked on stdin.
    fn install(
        &self,
        host: &InventoryHost,
        entry: &str,
        deadline: Option<Instant>,
        before_mutation: &mut dyn FnMut(&str) -> Result<(), String>,
    ) -> Result<bool, String>;

    fn revoke(
        &self,
        host: &InventoryHost,
        entry: &str,
        expected_host_key_fingerprint: Option<&str>,
    ) -> Result<bool, String>;
}

/// The shipped installer: in-process for this laptop, `ssh` for everything else.
pub(crate) struct SshExecInstaller {
    home: PathBuf,
    ssh: SystemSsh,
    remote_hmux: String,
    /// The wire-observed pin authorized before this laptop is mutated.
    this_laptop_pin: Option<String>,
}

impl SshExecInstaller {
    pub(crate) fn new(home: PathBuf, remote_hmux: String, this_laptop_pin: Option<String>) -> Self {
        Self {
            home,
            ssh: SystemSsh::from_environment(10),
            remote_hmux,
            this_laptop_pin,
        }
    }
}

impl AuthorizedKeyInstaller for SshExecInstaller {
    fn install(
        &self,
        host: &InventoryHost,
        entry: &str,
        deadline: Option<Instant>,
        before_mutation: &mut dyn FnMut(&str) -> Result<(), String>,
    ) -> Result<bool, String> {
        if matches!(&host.target, HostTarget::ThisLaptop) {
            let pin = self.this_laptop_pin.as_deref().ok_or_else(|| {
                "refusing to install this laptop without its observed SSH host-key pin".to_string()
            })?;
            before_mutation(pin)?;
            return apply_locally(&self.home, entry).map(|receipt| receipt.installed);
        }
        let request = serde_json::to_string(&ApplyRequest {
            version: APPLY_PROTOCOL_VERSION,
            entry: entry.to_string(),
        })
        .map(|request| format!("{request}\n"))
        .map_err(|error| format!("could not encode the install request: {error}"))?;
        let remote_arguments = [self.remote_hmux.as_str(), "pair", "apply-authorized-key"];
        let stdout =
            self.ssh
                .run_authenticated(host, &remote_arguments, &request, deadline, |pin| {
                    before_mutation(pin.as_str())
                })?;
        parse_receipt(&stdout, host).map(|receipt| receipt.installed)
    }

    fn revoke(
        &self,
        host: &InventoryHost,
        entry: &str,
        expected_host_key_fingerprint: Option<&str>,
    ) -> Result<bool, String> {
        if matches!(&host.target, HostTarget::ThisLaptop) {
            return revoke_locally(&self.home, entry);
        }
        let request = serde_json::to_string(&ApplyRequest {
            version: APPLY_PROTOCOL_VERSION,
            entry: entry.to_string(),
        })
        .map_err(|error| format!("could not encode the revoke request: {error}"))?;
        let remote_arguments = [self.remote_hmux.as_str(), "pair", "remove-authorized-key"];
        let stdout = self.ssh.run_authenticated(
            host,
            &remote_arguments,
            &format!("{request}\n"),
            None,
            |observed| match expected_host_key_fingerprint {
                Some(expected) if observed.as_str() != expected => Err(format!(
                    "refusing to revoke from {} because its SSH host key changed from {expected} to {}",
                    host.name,
                    observed.as_str()
                )),
                Some(_) | None => Ok(()),
            },
        )?;
        Ok(parse_receipt(&stdout, host)?.installed)
    }
}

/// Reads the receipt out of the remote's stdout.
///
/// The last non-empty line, not the whole stream: a login shell that prints a
/// banner before the forced program runs is common, and treating that banner as
/// a parse failure would report a *successful* install as a failed one.
fn parse_receipt(stdout: &str, host: &InventoryHost) -> Result<ApplyReceipt, String> {
    let line = stdout
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .ok_or_else(|| {
            format!(
                "{} answered nothing; is hmux installed there? \
                 (scripts/provision-hmux-remote.mjs installs it)",
                host.host
            )
        })?;
    let receipt: ApplyReceipt = serde_json::from_str(line.trim()).map_err(|error| {
        format!(
            "{} did not answer with an install receipt ({error}): {}",
            host.host,
            first_line(line)
        )
    })?;
    if receipt.version != APPLY_PROTOCOL_VERSION {
        return Err(format!(
            "{} runs an hmux that speaks pairing apply version {} rather than {APPLY_PROTOCOL_VERSION}",
            host.host, receipt.version
        ));
    }
    Ok(receipt)
}

fn first_line(text: &str) -> String {
    let trimmed = text.trim();
    let line = trimmed.lines().next().unwrap_or("").trim();
    if line.len() > 200 {
        format!("{}…", &line[..200])
    } else {
        line.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pairing::host_key;
    use crate::pairing::inventory::SshInvocation;

    fn remote(auth: &str) -> InventoryHost {
        InventoryHost {
            id: "a".into(),
            name: "build box".into(),
            host: "10.0.0.4".into(),
            port: 22,
            user: "kattpish".into(),
            auth: auth.into(),
            key_path: None,
            target: HostTarget::Remote(SshInvocation::Explicit),
        }
    }

    #[test]
    fn a_login_banner_before_the_receipt_does_not_read_as_a_failed_install() {
        let stdout = "Welcome to build box\nLast login: yesterday\n\
             {\"version\":1,\"installed\":true,\"already_present\":false,\
             \"authorized_keys_path\":\"/home/k/.ssh/authorized_keys\",\
             \"host_key_fingerprint\":null}\n";
        let receipt = parse_receipt(stdout, &remote("auto")).unwrap();
        assert!(receipt.installed);
    }

    #[test]
    fn the_wire_receipt_keeps_the_v1_pin_field_for_deployed_controllers() {
        let receipt = ApplyReceipt {
            version: APPLY_PROTOCOL_VERSION,
            installed: true,
            already_present: false,
            authorized_keys_path: "/home/k/.ssh/authorized_keys".into(),
        };
        let encoded = serialize_wire_receipt(&receipt, Some("SHA256:legacy")).unwrap();
        let wire: serde_json::Value = serde_json::from_str(&encoded).unwrap();

        assert_eq!(wire["host_key_fingerprint"], "SHA256:legacy");
    }

    #[test]
    fn a_server_with_no_hmux_says_so_instead_of_reporting_a_parse_error() {
        let error = parse_receipt("", &remote("auto")).unwrap_err();
        assert!(error.contains("provision-hmux-remote"), "{error}");
    }

    #[test]
    fn a_receipt_from_a_mismatched_protocol_version_is_refused() {
        let stdout = r#"{"version":9,"installed":true,"already_present":false,"authorized_keys_path":"x","host_key_fingerprint":null}"#;
        let error = parse_receipt(stdout, &remote("auto")).unwrap_err();
        assert!(error.contains("version 9"), "{error}");
    }

    /// A key-file change after rendering the QR must not replace the identity
    /// approved by the pre-mutation callback.
    #[test]
    fn the_installer_authorizes_the_pin_approved_before_the_key_file_changes() {
        let home = tempfile::tempdir().unwrap();
        let explicit = home.path().join("explicit_host_key.pub");
        std::fs::write(&explicit, "ssh-ed25519 AQID approved\n").unwrap();
        let approved = host_key::from_public_key_file(&explicit).unwrap().display;
        let installer = SshExecInstaller::new(
            home.path().to_path_buf(),
            "unused".into(),
            Some(approved.clone()),
        );
        std::fs::write(&explicit, "ssh-ed25519 BAUG changed\n").unwrap();
        let host = InventoryHost {
            id: "local".into(),
            name: "this laptop".into(),
            host: "127.0.0.1".into(),
            port: 22,
            user: "developer".into(),
            auth: "auto".into(),
            key_path: None,
            target: HostTarget::ThisLaptop,
        };

        let mut observed = None;
        let installed = installer
            .install(
                &host,
                "command=\"x\",restrict ssh-ed25519 AAAA hmux-pairing:d1",
                None,
                &mut |pin| {
                    observed = Some(pin.to_owned());
                    Ok(())
                },
            )
            .unwrap();

        assert!(installed);
        assert_eq!(observed.as_deref(), Some(approved.as_str()));
    }

    #[test]
    fn this_laptop_is_not_mutated_without_an_observed_pin() {
        let home = tempfile::tempdir().unwrap();
        let installer = SshExecInstaller::new(home.path().to_path_buf(), "unused".into(), None);
        let host = InventoryHost {
            id: "local".into(),
            name: "this laptop".into(),
            host: "127.0.0.1".into(),
            port: 22,
            user: "developer".into(),
            auth: "auto".into(),
            key_path: None,
            target: HostTarget::ThisLaptop,
        };

        let error = installer
            .install(
                &host,
                "command=\"x\",restrict ssh-ed25519 AAAA hmux-pairing:d1",
                None,
                &mut |_| Ok(()),
            )
            .unwrap_err();

        assert!(error.contains("observed SSH host-key pin"), "{error}");
        assert!(!home.path().join(".ssh/authorized_keys").exists());
    }

    #[test]
    fn applying_locally_is_idempotent_and_reports_which_it_was() {
        let home = tempfile::tempdir().unwrap();
        let entry = "command=\"x\",restrict ssh-ed25519 AAAA hmux-pairing:d1";
        let first = apply_locally(home.path(), entry).unwrap();
        assert!(!first.already_present);
        let second = apply_locally(home.path(), entry).unwrap();
        assert!(second.already_present);
        assert!(revoke_locally(home.path(), entry).unwrap());
        assert!(
            !revoke_locally(home.path(), entry).unwrap(),
            "a second revoke removed nothing and must say so"
        );
    }
}
