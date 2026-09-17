//! SSH credential overlays.
//!
//! The frontend supplies only a provider and a non-secret profile reference.
//! This backend owns the reviewed allowlist, remote path validation, shell
//! program, and credential bytes. Remote Hmux transport is deliberately not
//! implied here: callers explicitly choose either the legacy SSH launch path
//! or the journaled remote-managed broker after this preflight succeeds.

use crate::{accounts, remote_path::RemotePosixPath, ssh};
use dure_app::provider_credential_environment_policy_v1;
use hmux_client::ProviderStateEnvironment;
use serde::Serialize;
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static REMOTE_UPLOAD_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAccountOverlayReceipt {
    remote_directory: String,
    credential_present: bool,
    #[serde(skip_serializing)]
    remote_home: RemotePosixPath,
    #[serde(skip_serializing)]
    remote_profile_path: RemotePosixPath,
}

impl RemoteAccountOverlayReceipt {
    pub(crate) fn provider_state_environment(
        &self,
        provider: &str,
    ) -> Result<ProviderStateEnvironment, String> {
        let policy = provider_credential_environment_policy_v1(provider).ok_or_else(|| {
            typed_error(
                "remote_credential_alias_unsupported",
                format!("{provider} has no reviewed per-process state root"),
            )
        })?;
        let mut values = BTreeMap::new();
        if provider == "codex" {
            values.insert(
                policy.state_roots()[0].to_string(),
                self.remote_profile_path.to_string(),
            );
            let codex_home = self
                .remote_home
                .join_relative(".codex")
                .map_err(|error| typed_error("remote_credential_overlay_profile_invalid", error))?;
            values.insert(
                policy.state_roots()[1].to_string(),
                codex_home.to_string(),
            );
        } else {
            values.extend(
                policy.state_roots().iter().map(|state_root| {
                    (
                        (*state_root).to_string(),
                        self.remote_profile_path.to_string(),
                    )
                }),
            );
        }
        let removals = policy
            .selected_environment_removals()
            .iter()
            .map(ToString::to_string)
            .collect();
        ProviderStateEnvironment::from_mutations(values, removals).map_err(|error| {
            typed_error("remote_credential_environment_invalid", error.to_string())
        })
    }
}

fn typed_error(code: &str, message: impl AsRef<str>) -> String {
    format!("{code}: {}", message.as_ref())
}

pub(crate) fn validate_remote_directory(
    provider: &str,
    remote_directory: &str,
) -> Result<(), String> {
    let expected_prefix = format!("{provider}-");
    let mut components = remote_directory.split('/');
    let root_name = components.next();
    let accounts_name = components.next();
    let profile_name = components.next();
    let valid = root_name == Some(".dure")
        && accounts_name == Some("accounts")
        && profile_name.is_some_and(|name| {
            name.starts_with(&expected_prefix)
                && name.len() > expected_prefix.len()
                && name.len() <= 256
                && name[expected_prefix.len()..].chars().all(|character| {
                    character.is_ascii_alphanumeric() || matches!(character, '-' | '_')
                })
        })
        && components.next().is_none()
        && remote_directory.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_' | '/')
        });
    if !valid {
        return Err(typed_error(
            "remote_credential_directory_untrusted",
            "remote profile must be a provider-scoped path under .dure/accounts",
        ));
    }
    Ok(())
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

const REMOTE_OVERLAY_SCRIPT: &str = r#"set -eu

operation=$1
provider=$2
remote_directory=$3
require_credential=$4
credential_name=$5
canonical_name=$6
shared_names=$7
tooling_names=$8
append_names=$9
sync_names=${10}
upload_name=${11}
fail_after=${12}

typed_fail() {
  code=$1
  shift
  printf '%s: %s\n' "$code" "$*" >&2
  exit 64
}

exists() {
  [ -e "$1" ] || [ -L "$1" ]
}

owner_of() {
  stat -c %u "$1" 2>/dev/null || stat -f %u "$1"
}

links_of() {
  stat -c %h "$1" 2>/dev/null || stat -f %l "$1"
}

require_real_directory() {
  path=$1
  label=$2
  if [ ! -d "$path" ] || [ -L "$path" ]; then
    typed_fail remote_credential_directory_untrusted "$label must be a real directory"
  fi
  if [ "$(owner_of "$path")" != "$uid" ]; then
    typed_fail remote_credential_directory_untrusted "$label must be owned by the current user"
  fi
}

require_canonical_directory() {
  path=$1
  label=$2
  if [ ! -d "$path" ] || [ -L "$path" ]; then
    typed_fail remote_credential_overlay_source_untrusted "$label must be a real directory"
  fi
  if [ "$(owner_of "$path")" != "$uid" ]; then
    typed_fail remote_credential_overlay_source_untrusted "$label must be owned by the current user"
  fi
}

create_private_directory() {
  path=$1
  label=$2
  if ! exists "$path"; then
    mkdir "$path" 2>/dev/null || {
      exists "$path" ||
        typed_fail remote_credential_overlay_io "create $label"
    }
  fi
  require_real_directory "$path" "$label"
  chmod 700 "$path" || typed_fail remote_credential_overlay_io "secure $label"
}

reserve_canonical_directory() {
  path=$1
  created=0
  if ! exists "$path"; then
    if mkdir "$path" 2>/dev/null; then
      created=1
    else
      exists "$path" ||
        typed_fail remote_credential_overlay_io "reserve canonical shared directory"
    fi
  fi
  require_real_directory "$path" "canonical shared directory"
  if [ "$created" = "1" ]; then
    chmod 700 "$path" ||
      typed_fail remote_credential_overlay_io "secure canonical shared directory"
  fi
}

require_real_file() {
  path=$1
  label=$2
  if [ ! -f "$path" ] || [ -L "$path" ]; then
    typed_fail remote_credential_overlay_source_untrusted "$label must be a real file"
  fi
  if [ "$(owner_of "$path")" != "$uid" ]; then
    typed_fail remote_credential_overlay_source_untrusted "$label must be owned by the current user"
  fi
}

reserve_canonical_append_file() {
  path=$1
  created=0
  if ! exists "$path"; then
    if (umask 077; set -C; : > "$path") 2>/dev/null; then
      created=1
    else
      exists "$path" ||
        typed_fail remote_credential_overlay_io "reserve canonical append file"
    fi
  fi
  require_real_file "$path" "canonical append file"
  if [ "$created" = "1" ]; then
    chmod 600 "$path" ||
      typed_fail remote_credential_overlay_io "secure canonical append file"
  fi
}

acquire_lock() {
  attempts=0
  while ! mkdir "$lock" 2>/dev/null; do
    require_real_directory "$lock" "profile lock"
    attempts=$((attempts + 1))
    lock_pid=
    if [ -f "$lock/owner" ] && [ ! -L "$lock/owner" ]; then
      lock_pid=$(sed -n '1p' "$lock/owner" 2>/dev/null || true)
    fi
    case "$lock_pid" in
      ''|*[!0-9]*)
        if [ "$attempts" -gt 3 ]; then
          rm -f "$lock/owner" 2>/dev/null || true
          rmdir "$lock" 2>/dev/null || true
        fi
        ;;
      *)
        if ! kill -0 "$lock_pid" 2>/dev/null; then
          rm -f "$lock/owner" 2>/dev/null || true
          rmdir "$lock" 2>/dev/null || true
        fi
        ;;
    esac
    if [ "$attempts" -ge 20 ]; then
      typed_fail remote_credential_overlay_lock_failed "timed out waiting for the profile lock"
    fi
    sleep 1
  done
  printf '%s\n' "$$" > "$lock/owner"
  chmod 600 "$lock/owner"
}

release_lock() {
  rm -f "$lock/owner" 2>/dev/null || true
  rmdir "$lock" 2>/dev/null || true
}

record_created() {
  printf 'C\t%s\t-\n' "$1" >> "$journal"
}

record_created_directory() {
  printf 'D\t%s\t-\n' "$1" >> "$journal"
}

record_replaced() {
  printf 'R\t%s\t%s\n' "$1" "$2" >> "$journal"
}

after_mutation() {
  mutations=$((mutations + 1))
  if [ -n "$fail_after" ] && [ "$mutations" -eq "$fail_after" ]; then
    typed_fail remote_credential_overlay_fault_injected "test mutation boundary"
  fi
}

rollback() {
  [ -n "${journal:-}" ] && [ -f "$journal" ] || return 0
  awk '{ rows[NR]=$0 } END { for (i=NR; i>0; i--) print rows[i] }' "$journal" |
    while IFS="$(printf '\t')" read -r kind destination backup; do
      case "$kind" in
        C) rm -f "$destination" 2>/dev/null || true ;;
        D) rmdir "$destination" 2>/dev/null || true ;;
        R)
          rm -f "$destination" 2>/dev/null || true
          mv "$backup" "$destination" 2>/dev/null || true
          ;;
      esac
    done
}

cleanup_stage() {
  [ -n "${stage:-}" ] || return 0
  [ -d "$stage" ] || return 0
  find "$stage" -mindepth 1 -maxdepth 1 -exec rm -f -- {} \; 2>/dev/null || true
  rmdir "$stage" 2>/dev/null || true
}

finish() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$committed" -ne 1 ]; then rollback; fi
  cleanup_stage
  release_lock
  exit "$status"
}

case "$HOME" in
  *'
'*) typed_fail remote_credential_directory_untrusted "remote home contains a control character" ;;
esac
home=$(CDPATH= cd -- "$HOME" && pwd -P) ||
  typed_fail remote_credential_directory_untrusted "remote home is unavailable"
uid=$(id -u)
require_real_directory "$home" "remote home"

dure="$home/.dure"
legacy="$home/.hebbian"
if exists "$legacy" && [ ! -L "$legacy" ]; then
  require_real_directory "$legacy" "legacy app root"
fi
if [ -L "$legacy" ]; then
  if [ "$(owner_of "$legacy")" != "$uid" ]; then
    typed_fail remote_credential_directory_untrusted "legacy app root alias must be owned by the current user"
  fi
  legacy_target=$(readlink "$legacy") ||
    typed_fail remote_credential_directory_untrusted "inspect legacy app root alias"
  legacy_target_valid=0
  case "$legacy_target" in
    .dure|"$dure") legacy_target_valid=1 ;;
    /*)
      if [ -d "$dure" ] && [ ! -L "$dure" ]; then
        legacy_target_resolved=$(CDPATH= cd -- "$legacy" && pwd -P) || true
        dure_resolved=$(CDPATH= cd -- "$dure" && pwd -P) || true
        if [ -n "$legacy_target_resolved" ] && [ "$legacy_target_resolved" = "$dure_resolved" ]; then
          legacy_target_valid=1
        fi
      fi
      ;;
  esac
  if [ "$legacy_target_valid" != "1" ]; then
    typed_fail remote_credential_directory_untrusted "legacy app root alias must point directly to the home .dure directory"
  fi
fi
account_root="$dure/accounts"
profile="$home/$remote_directory"
profile_name=${remote_directory##*/}
canonical="$home/$canonical_name"
lock="$account_root/.overlay-lock-$profile_name"

create_private_directory "$dure" "Dure root"
if [ -L "$legacy" ]; then
  legacy_resolved=$(CDPATH= cd -- "$legacy" && pwd -P) ||
    typed_fail remote_credential_directory_untrusted "resolve legacy app root alias"
  if [ "$legacy_resolved" != "$dure" ]; then
    typed_fail remote_credential_directory_untrusted "legacy app root alias must resolve to the Dure root"
  fi
fi
create_private_directory "$account_root" "account root"
create_private_directory "$profile" "profile directory"
create_private_directory "$canonical" "canonical provider state"

acquire_lock
stage=
journal=
committed=0
mutations=0
trap finish EXIT HUP INT TERM
stage="$profile/.overlay-stage-$$-$(date +%s)"
mkdir "$stage" || typed_fail remote_credential_overlay_io "create transaction stage"
chmod 700 "$stage"
journal="$stage/journal"
: > "$journal"
chmod 600 "$journal"

credential="$profile/$credential_name"

harden_credential() {
  require_real_file "$credential" "$provider credential"
  credential_links=$(links_of "$credential")
  if [ "$credential_links" = "2" ]; then
    recovered_upload=
    for candidate in "$profile"/.hebbian-upload-*; do
      if ! exists "$candidate"; then continue; fi
      if [ -f "$candidate" ] && [ ! -L "$candidate" ] &&
         [ "$(owner_of "$candidate")" = "$uid" ] &&
         [ "$credential" -ef "$candidate" ]; then
        if [ -n "$recovered_upload" ]; then
          typed_fail remote_credential_file_untrusted "$provider credential has ambiguous upload links"
        fi
        recovered_upload=$candidate
      fi
    done
    if [ -n "$recovered_upload" ]; then
      rm -f "$recovered_upload" ||
        typed_fail remote_credential_overlay_io "remove committed upload residue"
      credential_links=$(links_of "$credential")
    fi
  fi
  if [ "$credential_links" != "1" ]; then
    typed_fail remote_credential_file_untrusted "$provider credential must have one link"
  fi
  chmod 600 "$credential" ||
    typed_fail remote_credential_overlay_io "secure provider credential"
}

if exists "$credential"; then
  harden_credential
  credential_present=1
else
  credential_present=0
fi

if [ "$operation" = "discard" ]; then
  case "$upload_name" in
    .hebbian-upload-[A-Za-z0-9_-]*) rm -f "$profile/$upload_name" ;;
    *) typed_fail remote_credential_upload_untrusted "unexpected upload artifact name" ;;
  esac
  committed=1
  exit 0
fi

if [ "$operation" = "commit" ]; then
  case "$upload_name" in
    .hebbian-upload-[A-Za-z0-9_-]*) ;;
    *) typed_fail remote_credential_upload_untrusted "unexpected upload artifact name" ;;
  esac
  upload="$profile/$upload_name"
  require_real_file "$upload" "uploaded credential"
  chmod 600 "$upload" ||
    typed_fail remote_credential_overlay_io "secure uploaded credential"
  if exists "$credential"; then
    harden_credential
    if cmp -s "$upload" "$credential"; then
      rm -f "$upload"
    else
      rm -f "$upload"
      typed_fail remote_credential_conflict "remote profile already has different credentials"
    fi
  else
    if ln "$upload" "$credential" 2>/dev/null; then
      rm -f "$upload" ||
        typed_fail remote_credential_overlay_io "finish uploaded credential publish"
      harden_credential
    elif exists "$credential"; then
      harden_credential
      if cmp -s "$upload" "$credential"; then
        rm -f "$upload"
      else
        rm -f "$upload"
        typed_fail remote_credential_conflict "remote profile was concurrently logged in"
      fi
    else
      typed_fail remote_credential_overlay_io "publish uploaded credential"
    fi
  fi
  committed=1
  printf 'profile=%s\nhome=%s\nprofile_path=%s\ncredential_present=1\n' "$remote_directory" "$home" "$profile"
  exit 0
fi

if [ "$operation" != "prepare" ]; then
  typed_fail remote_credential_overlay_operation_unsupported "unknown operation"
fi

for name in $shared_names; do
  source="$canonical/$name"
  destination="$profile/$name"
  reserve_canonical_directory "$source"
  if exists "$destination"; then
    if [ ! -L "$destination" ]; then
      typed_fail remote_credential_overlay_wrong_type "shared directory entry must be a symlink"
    fi
    if [ "$(readlink "$destination")" != "$source" ]; then
      typed_fail remote_credential_overlay_wrong_target "shared directory points outside canonical state"
    fi
  else
    ln -s "$source" "$destination" ||
      typed_fail remote_credential_overlay_io "publish shared directory"
    record_created "$destination"
    after_mutation
  fi
done

ensure_profile_parent_directories() {
  relative=$1
  parent=${relative%/*}
  if [ "$parent" = "$relative" ]; then return 0; fi
  old_ifs=$IFS
  IFS=/
  set -- $parent
  IFS=$old_ifs
  destination_parent=$profile
  for component do
    destination_parent="$destination_parent/$component"
    if exists "$destination_parent"; then
      require_real_directory "$destination_parent" "shared tooling parent"
      chmod 700 "$destination_parent" ||
        typed_fail remote_credential_overlay_io "secure shared tooling parent"
      continue
    fi
    mkdir "$destination_parent" ||
      typed_fail remote_credential_overlay_io "create shared tooling parent"
    record_created_directory "$destination_parent"
    chmod 700 "$destination_parent" ||
      typed_fail remote_credential_overlay_io "secure shared tooling parent"
    after_mutation
  done
}

select_canonical_tooling_directory() {
  relative=$1
  old_ifs=$IFS
  IFS=/
  set -- $relative
  IFS=$old_ifs
  source=$canonical
  for component do
    case "$component" in
      ''|.|..)
        typed_fail remote_credential_overlay_policy_invalid "shared tooling path must be relative"
        ;;
    esac
    source="$source/$component"
    if ! exists "$source"; then return 1; fi
    require_canonical_directory "$source" "canonical shared tooling directory"
  done
}

for name in $tooling_names; do
  if ! select_canonical_tooling_directory "$name"; then continue; fi
  ensure_profile_parent_directories "$name"
  destination="$profile/$name"
  if exists "$destination"; then
    if [ ! -L "$destination" ]; then
      typed_fail remote_credential_overlay_wrong_type "shared tooling entry must be a symlink"
    fi
    if [ "$(readlink "$destination")" != "$source" ]; then
      typed_fail remote_credential_overlay_wrong_target "shared tooling entry points outside canonical state"
    fi
  else
    ln -s "$source" "$destination" ||
      typed_fail remote_credential_overlay_io "publish shared tooling directory"
    record_created "$destination"
    after_mutation
  fi
done

for name in $append_names; do
  source="$canonical/$name"
  destination="$profile/$name"
  reserve_canonical_append_file "$source"
  if exists "$destination"; then
    require_real_file "$destination" "shared append entry"
    if [ ! "$source" -ef "$destination" ]; then
      typed_fail remote_credential_overlay_wrong_target "shared append entry is not the canonical inode"
    fi
  else
    ln "$source" "$destination" ||
      typed_fail remote_credential_overlay_io "publish shared append file"
    record_created "$destination"
    after_mutation
  fi
done

for name in $sync_names; do
  source="$canonical/$name"
  destination="$profile/$name"
  if ! exists "$source"; then continue; fi
  require_real_file "$source" "canonical spawn state"
  temporary="$stage/sync-$name"
  cp "$source" "$temporary" ||
    typed_fail remote_credential_overlay_io "stage spawn state"
  chmod 600 "$temporary"
  if exists "$destination"; then
    require_real_file "$destination" "spawn-synced entry"
    backup="$stage/backup-$name"
    ln "$destination" "$backup" ||
      typed_fail remote_credential_overlay_io "backup spawn state"
    mv "$temporary" "$destination" ||
      typed_fail remote_credential_overlay_io "publish spawn state"
    record_replaced "$destination" "$backup"
  else
    ln "$temporary" "$destination" ||
      typed_fail remote_credential_overlay_io "publish spawn state"
    rm -f "$temporary" ||
      typed_fail remote_credential_overlay_io "finish spawn state publish"
    record_created "$destination"
  fi
  after_mutation
done

if [ "$require_credential" = "1" ] && [ "$credential_present" != "1" ]; then
  typed_fail remote_credential_unavailable "remote profile has no credential"
fi

committed=1
printf 'profile=%s\nhome=%s\nprofile_path=%s\ncredential_present=%s\n' "$remote_directory" "$home" "$profile" "$credential_present"
"#;

fn overlay_command(
    operation: &str,
    provider: &str,
    remote_directory: &str,
    require_credential: bool,
    upload_name: &str,
    fail_after: Option<usize>,
) -> Result<String, String> {
    validate_remote_directory(provider, remote_directory)?;
    if matches!(operation, "commit" | "discard")
        && (!upload_name.starts_with(".hebbian-upload-")
            || upload_name.len() == ".hebbian-upload-".len()
            || !upload_name.chars().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_')
            }))
    {
        return Err(typed_error(
            "remote_credential_upload_untrusted",
            "unexpected upload artifact name",
        ));
    }
    let policy = accounts::reviewed_overlay_policy(provider)?;
    let arguments = [
        operation.to_string(),
        provider.to_string(),
        remote_directory.to_string(),
        if require_credential { "1" } else { "0" }.to_string(),
        policy.credential_file_name.to_string(),
        policy.canonical_directory_name.to_string(),
        policy.shared_directories.join(" "),
        policy.shared_tooling_directories.join(" "),
        policy.append_files.join(" "),
        policy.spawn_sync_files.join(" "),
        upload_name.to_string(),
        fail_after
            .map(|value| value.to_string())
            .unwrap_or_default(),
    ]
    .iter()
    .map(|argument| shell_quote(argument))
    .collect::<Vec<_>>()
    .join(" ");
    Ok(format!(
        "/bin/sh -s -- {arguments} <<'HEBBIAN_REMOTE_OVERLAY_V1'\n{REMOTE_OVERLAY_SCRIPT}\nHEBBIAN_REMOTE_OVERLAY_V1"
    ))
}

fn receipt_from_result(
    result: ssh::ExecResult,
    remote_directory: &str,
) -> Result<RemoteAccountOverlayReceipt, String> {
    if result.code != 0 {
        let detail = result.stderr.trim();
        return Err(if detail.is_empty() {
            typed_error(
                "remote_credential_overlay_failed",
                format!("remote overlay exited with status {}", result.code),
            )
        } else {
            detail.to_string()
        });
    }
    let profile_matches = result
        .stdout
        .lines()
        .any(|line| line == format!("profile={remote_directory}"));
    let credential_present = result
        .stdout
        .lines()
        .any(|line| line == "credential_present=1");
    let remote_home = result
        .stdout
        .split('\n')
        .find_map(|line| line.strip_prefix("home="))
        .and_then(|value| RemotePosixPath::from_absolute(value).ok())
        .ok_or_else(|| {
            typed_error(
                "remote_credential_overlay_receipt_invalid",
                "remote overlay omitted its absolute home",
            )
        })?;
    let remote_profile_path = result
        .stdout
        .split('\n')
        .find_map(|line| line.strip_prefix("profile_path="))
        .and_then(|value| RemotePosixPath::from_absolute(value).ok())
        .ok_or_else(|| {
            typed_error(
                "remote_credential_overlay_receipt_invalid",
                "remote overlay omitted its absolute profile path",
            )
        })?;
    let expected_profile = remote_home
        .join_relative(remote_directory)
        .map_err(|error| typed_error("remote_credential_overlay_receipt_invalid", error))?;
    if remote_profile_path != expected_profile {
        return Err(typed_error(
            "remote_credential_overlay_receipt_invalid",
            "remote overlay profile path changed",
        ));
    }
    if !profile_matches {
        return Err(typed_error(
            "remote_credential_overlay_receipt_invalid",
            "remote overlay did not return the expected profile receipt",
        ));
    }
    Ok(RemoteAccountOverlayReceipt {
        remote_directory: remote_directory.to_string(),
        credential_present,
        remote_home,
        remote_profile_path,
    })
}

pub fn prepare(
    opts: &ssh::SshOptions,
    provider: &str,
    remote_directory: &str,
    require_credential: bool,
) -> Result<RemoteAccountOverlayReceipt, String> {
    let command = overlay_command(
        "prepare",
        provider,
        remote_directory,
        require_credential,
        "",
        None,
    )?;
    receipt_from_result(ssh::exec_once(opts, &command)?, remote_directory)
}

pub fn copy_account(
    opts: &ssh::SshOptions,
    provider: &str,
    local_directory: &str,
    remote_directory: &str,
) -> Result<Vec<String>, String> {
    validate_remote_directory(provider, remote_directory)?;
    let home = std::env::var("HOME").map_err(|error| error.to_string())?;
    let (credential_name, credential_bytes) =
        accounts::read_profile_credential(provider, &home, local_directory)?;
    prepare(opts, provider, remote_directory, false)?;

    let sequence = REMOTE_UPLOAD_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let upload_name = format!(
        ".hebbian-upload-{}-{timestamp}-{sequence}",
        std::process::id()
    );
    let upload_path = format!("{remote_directory}/{upload_name}");
    if let Err(error) = ssh::upload_once(opts, &upload_path, credential_bytes) {
        if let Ok(command) = overlay_command(
            "discard",
            provider,
            remote_directory,
            false,
            &upload_name,
            None,
        ) {
            let _ = ssh::exec_once(opts, &command);
        }
        return Err(typed_error("remote_credential_upload_failed", error));
    }

    let commit_command = overlay_command(
        "commit",
        provider,
        remote_directory,
        false,
        &upload_name,
        None,
    )?;
    receipt_from_result(ssh::exec_once(opts, &commit_command)?, remote_directory)?;
    Ok(vec![credential_name])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_profile_name_has_a_hostile_input_bound() {
        assert!(validate_remote_directory(
            "codex",
            ".dure/accounts/codex-work"
        )
        .is_ok());
        assert!(validate_remote_directory(
            "codex",
            &format!(".dure/accounts/codex-{}", "x".repeat(251))
        )
        .is_err());
    }
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    use std::path::Path;
    use std::process::Command;

    fn run(
        home: &Path,
        operation: &str,
        provider: &str,
        remote_directory: &str,
        require_credential: bool,
        upload_name: &str,
        fail_after: Option<usize>,
    ) -> std::process::Output {
        let command = overlay_command(
            operation,
            provider,
            remote_directory,
            require_credential,
            upload_name,
            fail_after,
        )
        .unwrap();
        Command::new("/bin/sh")
            .arg("-c")
            .arg(command)
            .env("HOME", home)
            .output()
            .unwrap()
    }

    fn fixture(provider: &str) -> (tempfile::TempDir, std::path::PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        std::fs::create_dir(&home).unwrap();
        let canonical = home.join(
            accounts::reviewed_overlay_policy(provider)
                .unwrap()
                .canonical_directory_name,
        );
        std::fs::create_dir(&canonical).unwrap();
        (temp, home)
    }

    #[test]
    fn receipt_binds_absolute_remote_profile_paths_for_managed_launch() {
        let receipt = receipt_from_result(
            ssh::ExecResult {
                stdout: "profile=.dure/accounts/codex-work\ncredential_present=1\nhome=/home/agent's workspace\nprofile_path=/home/agent's workspace/.dure/accounts/codex-work\n".to_string(),
                stderr: String::new(),
                code: 0,
            },
            ".dure/accounts/codex-work",
        )
        .unwrap();
        let environment = receipt.provider_state_environment("codex").unwrap();
        assert_eq!(
            environment.values().get("CODEX_HOME").map(String::as_str),
            Some("/home/agent's workspace/.dure/accounts/codex-work")
        );
        assert_eq!(
            environment
                .values()
                .get("CODEX_SQLITE_HOME")
                .map(String::as_str),
            Some("/home/agent's workspace/.codex")
        );
        assert_eq!(
            environment.removals(),
            &std::collections::BTreeSet::from([
                "CODEX_ACCESS_TOKEN".into(),
                "CODEX_API_KEY".into(),
                "OPENAI_API_KEY".into(),
                "OPENAI_FEDERATION_RULE_ID".into(),
                "OPENAI_IDENTITY_TOKEN_FILE".into(),
            ])
        );

        let claude_receipt = receipt_from_result(
            ssh::ExecResult {
                stdout: "profile=.dure/accounts/claude-work\ncredential_present=1\nhome=/home/agent\nprofile_path=/home/agent/.dure/accounts/claude-work\n".to_string(),
                stderr: String::new(),
                code: 0,
            },
            ".dure/accounts/claude-work",
        )
        .unwrap();
        let claude_environment = claude_receipt.provider_state_environment("claude").unwrap();
        for state_root in ["ANTHROPIC_CONFIG_DIR", "CLAUDE_CONFIG_DIR"] {
            assert_eq!(
                claude_environment
                    .values()
                    .get(state_root)
                    .map(String::as_str),
                Some("/home/agent/.dure/accounts/claude-work"),
                "{state_root} did not select the remote profile",
            );
        }

        let changed = receipt_from_result(
            ssh::ExecResult {
                stdout: "profile=.dure/accounts/codex-work\ncredential_present=1\nhome=/home/agent\nprofile_path=/tmp/codex-work\n".to_string(),
                stderr: String::new(),
                code: 0,
            },
            ".dure/accounts/codex-work",
        )
        .unwrap_err();
        assert!(changed.starts_with("remote_credential_overlay_receipt_invalid:"));
    }

    #[test]
    fn prepares_reviewed_links_and_atomic_spawn_state_with_private_permissions() {
        let (_temp, home) = fixture("codex");
        let canonical = home.join(".codex");
        std::fs::write(canonical.join("config.toml"), b"model = 'shared'").unwrap();

        let output = run(
            &home,
            "prepare",
            "codex",
            ".dure/accounts/codex-work",
            false,
            "",
            None,
        );
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let profile = home.join(".dure/accounts/codex-work");
        let policy = accounts::reviewed_overlay_policy("codex").unwrap();
        for name in policy.shared_directories {
            assert_eq!(
                std::fs::read_link(profile.join(name)).unwrap(),
                std::fs::canonicalize(canonical.join(name)).unwrap()
            );
        }
        for name in policy.append_files {
            let source = std::fs::metadata(canonical.join(name)).unwrap();
            let shared = std::fs::metadata(profile.join(name)).unwrap();
            assert_eq!((source.dev(), source.ino()), (shared.dev(), shared.ino()));
        }
        assert_eq!(
            std::fs::read(profile.join("config.toml")).unwrap(),
            b"model = 'shared'"
        );
        assert_eq!(
            std::fs::metadata(&profile).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::metadata(profile.join("config.toml"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }

    #[test]
    fn existing_remote_profile_converges_onto_canonical_standalone_tooling() {
        let (_temp, home) = fixture("codex");
        let remote_directory = ".dure/accounts/codex-work";
        let first = run(&home, "prepare", "codex", remote_directory, false, "", None);
        assert!(
            first.status.success(),
            "{}",
            String::from_utf8_lossy(&first.stderr)
        );

        let standalone = home.join(".codex/packages/standalone");
        std::fs::create_dir_all(standalone.join("current")).unwrap();
        std::fs::write(standalone.join("current/codex"), b"remote provider").unwrap();
        let interrupted = run(
            &home,
            "prepare",
            "codex",
            remote_directory,
            false,
            "",
            Some(2),
        );
        assert!(!interrupted.status.success());
        assert!(!home.join(remote_directory).join("packages").exists());

        let second = run(&home, "prepare", "codex", remote_directory, false, "", None);
        assert!(
            second.status.success(),
            "{}",
            String::from_utf8_lossy(&second.stderr)
        );

        let profile = home.join(remote_directory);
        assert_eq!(
            std::fs::read_link(profile.join("packages/standalone")).unwrap(),
            std::fs::canonicalize(&standalone).unwrap()
        );
        assert_eq!(
            std::fs::read(profile.join("packages/standalone/current/codex")).unwrap(),
            b"remote provider"
        );
        assert!(!profile.join("auth.json").exists());
    }

    #[test]
    fn remote_canonical_tooling_rejects_a_symlinked_parent_directory() {
        let (temp, home) = fixture("codex");
        let external_packages = temp.path().join("external-packages");
        std::fs::create_dir(&external_packages).unwrap();
        std::os::unix::fs::symlink(&external_packages, home.join(".codex/packages")).unwrap();

        let output = run(
            &home,
            "prepare",
            "codex",
            ".dure/accounts/codex-work",
            false,
            "",
            None,
        );

        assert!(!output.status.success());
        assert!(
            String::from_utf8_lossy(&output.stderr)
                .starts_with("remote_credential_overlay_source_untrusted:"),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(!home.join(".dure/accounts/codex-work/packages").exists());
    }

    #[test]
    fn accepts_only_the_exact_dure_compatibility_alias() {
        let (_temp, home) = fixture("codex");
        std::os::unix::fs::symlink(".dure", home.join(".hebbian")).unwrap();
        let accepted = run(
            &home,
            "prepare",
            "codex",
            ".dure/accounts/codex-work",
            false,
            "",
            None,
        );
        assert!(
            accepted.status.success(),
            "{}",
            String::from_utf8_lossy(&accepted.stderr)
        );

        let (_absolute_temp, absolute_home) = fixture("codex");
        std::fs::create_dir(absolute_home.join(".dure")).unwrap();
        std::os::unix::fs::symlink(
            absolute_home.join(".dure"),
            absolute_home.join(".hebbian"),
        )
        .unwrap();
        let accepted = run(
            &absolute_home,
            "prepare",
            "codex",
            ".dure/accounts/codex-work",
            false,
            "",
            None,
        );
        assert!(
            accepted.status.success(),
            "{}",
            String::from_utf8_lossy(&accepted.stderr)
        );

        let (_other_temp, other_home) = fixture("codex");
        let outside = other_home.parent().unwrap().join("outside");
        std::fs::create_dir(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, other_home.join(".hebbian")).unwrap();
        let rejected = run(
            &other_home,
            "prepare",
            "codex",
            ".dure/accounts/codex-work",
            false,
            "",
            None,
        );
        assert!(!rejected.status.success());
        assert!(String::from_utf8_lossy(&rejected.stderr)
            .contains("remote_credential_directory_untrusted"));
        assert!(!other_home.join(".dure").exists());
        assert!(!outside.join("accounts").exists());

        let (_file_temp, file_home) = fixture("codex");
        let legacy_file = file_home.join(".hebbian");
        std::fs::write(&legacy_file, b"not a directory").unwrap();
        let rejected = run(
            &file_home,
            "prepare",
            "codex",
            ".dure/accounts/codex-work",
            false,
            "",
            None,
        );
        assert!(!rejected.status.success());
        assert!(String::from_utf8_lossy(&rejected.stderr)
            .contains("remote_credential_directory_untrusted"));
        assert_eq!(std::fs::read(&legacy_file).unwrap(), b"not a directory");
        assert!(!file_home.join(".dure").exists());
    }

    #[test]
    fn dure_credentials_coexist_with_owned_real_legacy_runtime_directory() {
        let (_temp, home) = fixture("codex");
        let legacy_runtime = home.join(".hebbian/bin");
        std::fs::create_dir_all(&legacy_runtime).unwrap();
        let legacy_session = legacy_runtime.join("hebbian-session");
        std::fs::write(&legacy_session, b"existing remote session runtime").unwrap();
        let legacy_root = home.join(".hebbian");
        let legacy_mode_before = std::fs::metadata(&legacy_root)
            .unwrap()
            .permissions()
            .mode()
            & 0o777;

        let output = run(
            &home,
            "prepare",
            "codex",
            ".dure/accounts/codex-work",
            false,
            "",
            None,
        );
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(home.join(".dure/accounts/codex-work").is_dir());
        assert_eq!(
            std::fs::read(&legacy_session).unwrap(),
            b"existing remote session runtime"
        );
        assert!(!std::fs::symlink_metadata(&legacy_root)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(
            std::fs::metadata(&legacy_root)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            legacy_mode_before
        );
    }

    #[test]
    fn wrong_shared_target_fails_closed_without_touching_either_target() {
        let (_temp, home) = fixture("codex");
        let canonical = home.join(".codex");
        let outside = home.join("outside");
        std::fs::create_dir(canonical.join("sessions")).unwrap();
        std::fs::create_dir(&outside).unwrap();
        let profile = home.join(".dure/accounts/codex-work");
        std::fs::create_dir_all(&profile).unwrap();
        std::os::unix::fs::symlink(&outside, profile.join("sessions")).unwrap();

        let output = run(
            &home,
            "prepare",
            "codex",
            ".dure/accounts/codex-work",
            false,
            "",
            None,
        );
        assert!(!output.status.success());
        assert!(String::from_utf8_lossy(&output.stderr)
            .contains("remote_credential_overlay_wrong_target"));
        assert_eq!(
            std::fs::read_link(profile.join("sessions")).unwrap(),
            outside
        );
    }

    #[test]
    fn injected_failure_rolls_back_every_published_entry() {
        let (_temp, home) = fixture("codex");
        std::fs::create_dir(home.join(".codex/sessions")).unwrap();
        std::fs::write(home.join(".codex/history.jsonl"), b"history").unwrap();

        let output = run(
            &home,
            "prepare",
            "codex",
            ".dure/accounts/codex-work",
            false,
            "",
            Some(2),
        );
        assert!(!output.status.success());
        let profile = home.join(".dure/accounts/codex-work");
        assert!(!profile.join("sessions").exists());
        assert!(!profile.join("history.jsonl").exists());
    }

    #[test]
    fn a_retry_repairs_valid_crash_residue_without_deleting_unknown_state() {
        let (_temp, home) = fixture("codex");
        std::fs::write(home.join(".codex/config.toml"), b"current").unwrap();
        let profile = home.join(".dure/accounts/codex-work");
        let stale = profile.join(".overlay-stage-dead");
        std::fs::create_dir_all(&stale).unwrap();
        std::fs::write(stale.join("unknown"), b"preserve").unwrap();

        let output = run(
            &home,
            "prepare",
            "codex",
            ".dure/accounts/codex-work",
            false,
            "",
            None,
        );
        assert!(output.status.success());
        assert_eq!(
            std::fs::read(profile.join("config.toml")).unwrap(),
            b"current"
        );
        assert_eq!(std::fs::read(stale.join("unknown")).unwrap(), b"preserve");
    }

    #[test]
    fn different_profiles_remain_isolated_during_concurrent_preparation() {
        let (_temp, home) = fixture("claude");
        std::fs::create_dir(home.join(".claude/projects")).unwrap();
        let home_a = home.clone();
        let first = std::thread::spawn(move || {
            run(
                &home_a,
                "prepare",
                "claude",
                ".dure/accounts/claude-a",
                false,
                "",
                None,
            )
        });
        let home_b = home.clone();
        let second = std::thread::spawn(move || {
            run(
                &home_b,
                "prepare",
                "claude",
                ".dure/accounts/claude-b",
                false,
                "",
                None,
            )
        });
        assert!(first.join().unwrap().status.success());
        assert!(second.join().unwrap().status.success());
        assert!(home
            .join(".dure/accounts/claude-a/projects")
            .is_symlink());
        assert!(home
            .join(".dure/accounts/claude-b/projects")
            .is_symlink());
    }

    #[test]
    fn credential_commit_is_idempotent_but_never_overwrites_a_different_login() {
        let (_temp, home) = fixture("codex");
        let remote_directory = ".dure/accounts/codex-work";
        assert!(
            run(&home, "prepare", "codex", remote_directory, false, "", None,)
                .status
                .success()
        );
        let profile = home.join(remote_directory);
        let other_profile = home.join(".dure/accounts/codex-other");
        std::fs::create_dir(&other_profile).unwrap();
        std::fs::write(other_profile.join("auth.json"), b"other-profile").unwrap();
        std::fs::write(profile.join(".hebbian-upload-first"), b"first").unwrap();
        assert!(run(
            &home,
            "commit",
            "codex",
            remote_directory,
            false,
            ".hebbian-upload-first",
            None,
        )
        .status
        .success());
        std::fs::write(profile.join(".hebbian-upload-same"), b"first").unwrap();
        assert!(run(
            &home,
            "commit",
            "codex",
            remote_directory,
            false,
            ".hebbian-upload-same",
            None,
        )
        .status
        .success());
        std::fs::write(profile.join(".hebbian-upload-other"), b"other").unwrap();
        let conflict = run(
            &home,
            "commit",
            "codex",
            remote_directory,
            false,
            ".hebbian-upload-other",
            None,
        );
        assert!(!conflict.status.success());
        assert!(String::from_utf8_lossy(&conflict.stderr).contains("remote_credential_conflict"));
        assert_eq!(std::fs::read(profile.join("auth.json")).unwrap(), b"first");
        assert_eq!(
            std::fs::read(other_profile.join("auth.json")).unwrap(),
            b"other-profile"
        );
        assert!(!profile.join(".hebbian-upload-other").exists());
    }

    #[test]
    fn login_refresh_and_logout_remain_profile_local() {
        let (_temp, home) = fixture("claude");
        let first_directory = ".dure/accounts/claude-first";
        let second_directory = ".dure/accounts/claude-second";
        for directory in [first_directory, second_directory] {
            assert!(run(&home, "prepare", "claude", directory, false, "", None)
                .status
                .success());
        }
        let first = home.join(first_directory).join(".credentials.json");
        let second = home.join(second_directory).join(".credentials.json");
        std::fs::write(&first, b"first-login").unwrap();
        std::fs::write(&second, b"second-login").unwrap();
        for directory in [first_directory, second_directory] {
            assert!(run(&home, "prepare", "claude", directory, true, "", None)
                .status
                .success());
        }

        std::fs::write(&first, b"first-refreshed").unwrap();
        assert_eq!(std::fs::read(&second).unwrap(), b"second-login");
        std::fs::remove_file(&first).unwrap();

        let first_logout = run(&home, "prepare", "claude", first_directory, true, "", None);
        assert!(!first_logout.status.success());
        assert!(
            String::from_utf8_lossy(&first_logout.stderr).contains("remote_credential_unavailable")
        );
        assert!(
            run(&home, "prepare", "claude", second_directory, true, "", None,)
                .status
                .success()
        );
        assert_eq!(std::fs::read(&second).unwrap(), b"second-login");
    }

    #[test]
    fn retry_finishes_a_credential_publish_interrupted_after_atomic_link() {
        let (_temp, home) = fixture("codex");
        let profile = home.join(".dure/accounts/codex-work");
        std::fs::create_dir_all(&profile).unwrap();
        std::fs::write(profile.join(".hebbian-upload-crash"), b"credential").unwrap();
        std::fs::hard_link(
            profile.join(".hebbian-upload-crash"),
            profile.join("auth.json"),
        )
        .unwrap();

        let retry = run(
            &home,
            "prepare",
            "codex",
            ".dure/accounts/codex-work",
            true,
            "",
            None,
        );
        assert!(
            retry.status.success(),
            "{}",
            String::from_utf8_lossy(&retry.stderr)
        );
        assert!(!profile.join(".hebbian-upload-crash").exists());
        assert_eq!(
            std::fs::metadata(profile.join("auth.json"))
                .unwrap()
                .nlink(),
            1
        );
    }

    #[test]
    fn rejects_paths_outside_the_provider_account_root_before_building_shell() {
        for path in [
            ".dure/accounts/claude-work",
            ".dure/accounts/codex-work/extra",
            ".dure/accounts/codex-..",
            ".dure/accounts/codex-../outside",
            "/tmp/codex-work",
        ] {
            assert!(overlay_command("prepare", "codex", path, false, "", None).is_err());
        }
        assert!(overlay_command(
            "commit",
            "codex",
            ".dure/accounts/codex-work",
            false,
            ".hebbian-upload-good/../../outside",
            None,
        )
        .is_err());
    }
}
