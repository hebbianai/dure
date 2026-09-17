use std::sync::OnceLock;
#[cfg(not(windows))]
use sysinfo::{Pid, ProcessesToUpdate, System};

#[cfg(windows)]
use hmux_client::{
    exact_local_process_generation, probe_local_process_generation, LocalProcessGenerationStatus,
    ProcessDescriptor,
};

const SSH_SECRET_SERVICE: &str = "ai.hebbian.HebbianIDE.ssh";
const SSH_SECRET_SOURCE_MISSING: &str = "ssh_secret_source_missing";

#[derive(Clone)]
struct SecretId(String);

impl SecretId {
    fn parse(value: &str) -> Result<Self, String> {
        if value.is_empty()
            || value.len() > 128
            || !value.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b':' | b'.')
            })
        {
            return Err("invalid SSH secret id".into());
        }
        Ok(Self(value.to_owned()))
    }

    fn as_str(&self) -> &str {
        &self.0
    }
}

fn entry(id: &SecretId) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SSH_SECRET_SERVICE, id.as_str())
        .map_err(|error| format!("open system credential store: {error}"))
}

#[cfg(not(windows))]
fn process_start_time(pid: u32) -> Option<u64> {
    let pid = Pid::from_u32(pid);
    let mut system = System::new();
    system.refresh_processes(ProcessesToUpdate::Some(&[pid]), true);
    system.process(pid).map(|process| process.start_time())
}

pub fn ssh_credential_process_generation() -> Result<&'static str, String> {
    static GENERATION: OnceLock<Result<String, String>> = OnceLock::new();
    match GENERATION.get_or_init(|| {
        let pid = std::process::id();
        #[cfg(windows)]
        {
            let process = exact_local_process_generation(pid).map_err(|error| {
                format!("ssh_credential_process_generation_unavailable: {error}")
            })?;
            Ok(format!(
                "windows:{}:{}",
                process.process_id, process.start_marker
            ))
        }
        #[cfg(not(windows))]
        let started = process_start_time(pid)
            .filter(|started| *started > 0)
            .ok_or_else(|| "ssh_credential_process_generation_unavailable".to_string())?;
        #[cfg(not(windows))]
        Ok(format!("{pid}:{started}"))
    }) {
        Ok(generation) => Ok(generation),
        Err(error) => Err(error.clone()),
    }
}

pub fn ssh_credential_process_generation_definitely_dead(generation: &str) -> bool {
    #[cfg(windows)]
    {
        let Some((pid, start_marker)) = generation
            .strip_prefix("windows:")
            .and_then(|value| value.split_once(':'))
        else {
            return false;
        };
        let Ok(process_id) = pid.parse::<u32>() else {
            return false;
        };
        matches!(
            probe_local_process_generation(&ProcessDescriptor {
                process_id,
                start_marker: start_marker.to_string(),
            }),
            Ok(LocalProcessGenerationStatus::Absent)
        )
    }
    #[cfg(not(windows))]
    {
        let Some((pid, started)) = generation.split_once(':') else {
            return false;
        };
        let Ok(pid) = pid.parse::<u32>() else {
            return false;
        };
        let Ok(started) = started.parse::<u64>() else {
            return false;
        };
        if pid == 0 || started == 0 {
            return false;
        }
        if crate::process_liveness::definitely_dead(pid) {
            return true;
        }
        process_start_time(pid).is_some_and(|current| current != started)
    }
}

pub fn set_ssh_secret(id: &str, value: &str) -> Result<(), String> {
    if value.is_empty() {
        return Err("SSH password is empty".into());
    }
    entry(&SecretId::parse(id)?)?
        .set_password(value)
        .map_err(|error| format!("save SSH password to system credential store: {error}"))
}

pub fn get_ssh_secret(id: &str) -> Result<Option<String>, String> {
    match entry(&SecretId::parse(id)?)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!(
            "read SSH password from system credential store: {error}"
        )),
    }
}

fn copy_source_value(result: Result<String, keyring::Error>) -> Result<String, String> {
    match result {
        Ok(value) => Ok(value),
        Err(keyring::Error::NoEntry) => Err(SSH_SECRET_SOURCE_MISSING.into()),
        Err(error) => Err(format!(
            "read SSH password for copy from system credential store: {error}"
        )),
    }
}

pub fn copy_ssh_secret(source: &str, destination: &str) -> Result<(), String> {
    let source = SecretId::parse(source)?;
    let destination = SecretId::parse(destination)?;
    let value = copy_source_value(entry(&source)?.get_password())?;
    entry(&destination)?
        .set_password(&value)
        .map_err(|error| format!("copy SSH password to system credential store: {error}"))
}

pub fn delete_ssh_secret(id: &str) -> Result<(), String> {
    match entry(&SecretId::parse(id)?)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!(
            "delete SSH password from system credential store: {error}"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        copy_source_value, copy_ssh_secret, ssh_credential_process_generation,
        ssh_credential_process_generation_definitely_dead, SecretId, SSH_SECRET_SOURCE_MISSING,
    };

    #[test]
    fn secret_ids_are_restricted_to_host_style_identifiers() {
        assert!(SecretId::parse("host-Abc_123").is_ok());
        assert!(SecretId::parse("../other-service").is_err());
        assert!(SecretId::parse("").is_err());
    }

    #[test]
    fn process_generation_is_stable_for_this_native_process() {
        let generation = ssh_credential_process_generation().unwrap();
        assert!(!generation.is_empty());
        assert_eq!(
            ssh_credential_process_generation().unwrap(),
            ssh_credential_process_generation().unwrap()
        );
        assert!(!ssh_credential_process_generation_definitely_dead(
            generation
        ));
        assert!(!ssh_credential_process_generation_definitely_dead(
            "invalid"
        ));
    }

    #[cfg(windows)]
    #[test]
    fn unverifiable_windows_generation_never_grants_cleanup_authority() {
        let generation = format!(
            "windows:{}:future-windows-process-marker",
            std::process::id()
        );
        assert!(!ssh_credential_process_generation_definitely_dead(
            &generation
        ));
    }

    #[test]
    fn copy_source_missing_has_a_stable_error() {
        assert_eq!(
            copy_source_value(Err(keyring::Error::NoEntry)),
            Err(SSH_SECRET_SOURCE_MISSING.to_string())
        );
    }

    #[test]
    fn copy_rejects_both_invalid_ids_before_opening_the_store() {
        assert_eq!(
            copy_ssh_secret("../source", "host-destination"),
            Err("invalid SSH secret id".to_string())
        );
        assert_eq!(
            copy_ssh_secret("host-source", "../destination"),
            Err("invalid SSH secret id".to_string())
        );
    }

    #[test]
    fn copy_preserves_an_existing_blank_secret() {
        assert_eq!(copy_source_value(Ok(String::new())), Ok(String::new()));
    }
}
