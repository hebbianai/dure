use fs2::FileExt;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs::OpenOptions;
use std::path::Path;

const REGISTRY_FILE_NAME: &str = "ssh-credential-registry.json";
const LOCK_FILE_NAME: &str = ".ssh-credential-registry.lock";
const REGISTRY_VERSION: u8 = 1;
const MAX_CLAIMS: usize = 4_096;
const MAX_HOST_ID_BYTES: usize = 1_024;
const MAX_GENERATION_BYTES: usize = 128;

fn owned_credential_id(value: &str) -> bool {
    value.strip_prefix("ssh-").is_some_and(|suffix| {
        suffix.len() == 32
            && suffix
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    })
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SshCredentialClaimV1 {
    schema_version: u8,
    id: String,
    host_id: String,
    registration_generation: String,
}

impl SshCredentialClaimV1 {
    fn validate(self) -> Result<Self, String> {
        if self.schema_version != 1
            || !owned_credential_id(&self.id)
            || self.host_id.is_empty()
            || self.host_id.len() > MAX_HOST_ID_BYTES
            || self.registration_generation.is_empty()
            || self.registration_generation.len() > MAX_GENERATION_BYTES
        {
            return Err("ssh_credential_claim_invalid".to_string());
        }
        Ok(self)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RegistryEntryV1 {
    #[serde(flatten)]
    claim: SshCredentialClaimV1,
    touched_process_generation: String,
    phase: CredentialPhase,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum CredentialPhase {
    Staged,
    Live,
    Retiring,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RegistryV1 {
    version: u8,
    entries: Vec<RegistryEntryV1>,
}

impl Default for RegistryV1 {
    fn default() -> Self {
        Self {
            version: REGISTRY_VERSION,
            entries: Vec::new(),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshCredentialCleanupFailure {
    id: String,
    error: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshCredentialCleanupReport {
    deleted: Vec<String>,
    retained: Vec<String>,
    failures: Vec<SshCredentialCleanupFailure>,
}

fn registry_path() -> Result<std::path::PathBuf, String> {
    crate::app_channel::current()
        .map(|channel| channel.control_dir.join(REGISTRY_FILE_NAME))
        .map_err(|error| format!("ssh_credential_registry_unavailable: {error}"))
}

#[cfg(unix)]
fn owner_only_options(options: &mut OpenOptions) {
    use std::os::unix::fs::OpenOptionsExt;
    options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
}

#[cfg(not(unix))]
fn owner_only_options(_options: &mut OpenOptions) {}

fn read_registry(path: &Path) -> Result<RegistryV1, String> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(RegistryV1::default());
        }
        Err(error) => return Err(format!("ssh_credential_registry_read_failed: {error}")),
    };
    let registry: RegistryV1 = serde_json::from_slice(&bytes)
        .map_err(|error| format!("ssh_credential_registry_invalid: {error}"))?;
    if registry.version != REGISTRY_VERSION || registry.entries.len() > MAX_CLAIMS {
        return Err("ssh_credential_registry_invalid".to_string());
    }
    let mut ids = HashSet::new();
    for entry in &registry.entries {
        entry.claim.clone().validate()?;
        if entry.touched_process_generation.is_empty() || !ids.insert(entry.claim.id.as_str()) {
            return Err("ssh_credential_registry_invalid".to_string());
        }
    }
    Ok(registry)
}

fn publish_registry(path: &Path, registry: &RegistryV1) -> Result<(), String> {
    let json = serde_json::to_string(registry)
        .map_err(|error| format!("ssh_credential_registry_encode_failed: {error}"))?;
    crate::agent_registry::publish(path, &json)
        .map_err(|error| format!("ssh_credential_registry_write_failed: {error}"))
}

fn with_registry<R>(
    path: &Path,
    operation: impl FnOnce(&mut RegistryV1) -> Result<(R, bool), String>,
) -> Result<R, String> {
    let parent = path
        .parent()
        .ok_or_else(|| "ssh_credential_registry_parent_missing".to_string())?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("ssh_credential_registry_unavailable: {error}"))?;
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true);
    owner_only_options(&mut options);
    let lock = options
        .open(parent.join(LOCK_FILE_NAME))
        .map_err(|error| format!("ssh_credential_registry_lock_failed: {error}"))?;
    lock.lock_exclusive()
        .map_err(|error| format!("ssh_credential_registry_lock_failed: {error}"))?;
    crate::agent_registry::recover(path)
        .map_err(|error| format!("ssh_credential_registry_recovery_failed: {error}"))?;
    let mut registry = read_registry(path)?;
    let (result, changed) = operation(&mut registry)?;
    if changed {
        publish_registry(path, &registry)?;
    }
    Ok(result)
}

fn validated_claims(
    claims: Vec<SshCredentialClaimV1>,
) -> Result<Vec<SshCredentialClaimV1>, String> {
    if claims.len() > MAX_CLAIMS {
        return Err("ssh_credential_claims_too_large".to_string());
    }
    let mut by_id = HashMap::new();
    for claim in claims {
        let claim = claim.validate()?;
        match by_id.get(&claim.id) {
            Some(existing) if existing != &claim => {
                return Err("ssh_credential_registry_identity_conflict".to_string());
            }
            Some(_) => {}
            None => {
                by_id.insert(claim.id.clone(), claim);
            }
        }
    }
    Ok(by_id.into_values().collect())
}

fn transition_registry(
    registry: &mut RegistryV1,
    claims: &[SshCredentialClaimV1],
    process_generation: &str,
    phase: CredentialPhase,
) -> Result<bool, String> {
    let mut changed = false;
    for claim in claims {
        if let Some(entry) = registry
            .entries
            .iter_mut()
            .find(|entry| entry.claim.id == claim.id)
        {
            if entry.claim != *claim {
                return Err("ssh_credential_registry_identity_conflict".to_string());
            }
            let next_phase = match (entry.phase, phase) {
                (CredentialPhase::Live, CredentialPhase::Staged) => CredentialPhase::Live,
                (CredentialPhase::Retiring, CredentialPhase::Staged) => {
                    return Err("ssh_credential_claim_retired".to_string());
                }
                (_, next) => next,
            };
            if entry.touched_process_generation != process_generation || entry.phase != next_phase {
                entry.touched_process_generation = process_generation.to_string();
                entry.phase = next_phase;
                changed = true;
            }
        } else {
            if registry.entries.len() >= MAX_CLAIMS {
                return Err("ssh_credential_claims_too_large".to_string());
            }
            registry.entries.push(RegistryEntryV1 {
                claim: claim.clone(),
                touched_process_generation: process_generation.to_string(),
                phase,
            });
            changed = true;
        }
    }
    Ok(changed)
}

fn transition_at(
    path: &Path,
    claims: Vec<SshCredentialClaimV1>,
    process_generation: &str,
    phase: CredentialPhase,
) -> Result<(), String> {
    let claims = validated_claims(claims)?;
    with_registry(path, |registry| {
        let changed = transition_registry(registry, &claims, process_generation, phase)?;
        Ok(((), changed))
    })
}

pub fn stage(claims: Vec<SshCredentialClaimV1>) -> Result<(), String> {
    let generation = crate::secrets::ssh_credential_process_generation()?;
    transition_at(
        &registry_path()?,
        claims,
        generation,
        CredentialPhase::Staged,
    )
}

pub fn activate(claims: Vec<SshCredentialClaimV1>) -> Result<(), String> {
    let generation = crate::secrets::ssh_credential_process_generation()?;
    transition_at(&registry_path()?, claims, generation, CredentialPhase::Live)
}

pub fn retire(claims: Vec<SshCredentialClaimV1>) -> Result<(), String> {
    let generation = crate::secrets::ssh_credential_process_generation()?;
    transition_at(
        &registry_path()?,
        claims,
        generation,
        CredentialPhase::Retiring,
    )
}

fn reconcile_at(
    path: &Path,
    live_claims: Vec<SshCredentialClaimV1>,
    referenced_ids: Vec<String>,
    process_generation: &str,
    mut process_definitely_dead: impl FnMut(&str) -> bool,
    mut delete: impl FnMut(&str) -> Result<(), String>,
) -> Result<SshCredentialCleanupReport, String> {
    let live_claims = validated_claims(live_claims)?;
    let referenced_ids = referenced_ids
        .into_iter()
        .filter(|id| owned_credential_id(id))
        .collect::<HashSet<_>>();
    if referenced_ids.len() > MAX_CLAIMS {
        return Err("ssh_credential_references_invalid".to_string());
    }
    with_registry(path, |registry| {
        let mut changed = transition_registry(
            registry,
            &live_claims,
            process_generation,
            CredentialPhase::Live,
        )?;
        for entry in &mut registry.entries {
            if referenced_ids.contains(&entry.claim.id)
                && (entry.touched_process_generation != process_generation
                    || entry.phase != CredentialPhase::Live)
            {
                entry.touched_process_generation = process_generation.to_string();
                entry.phase = CredentialPhase::Live;
                changed = true;
            }
        }

        let mut deleted = Vec::new();
        let mut retained = Vec::new();
        let mut failures = Vec::new();
        let mut dead_process_generations = HashMap::new();
        registry.entries.retain(|entry| {
            if entry.phase == CredentialPhase::Live
                || referenced_ids.contains(&entry.claim.id)
                || entry.touched_process_generation == process_generation
            {
                retained.push(entry.claim.id.clone());
                return true;
            }
            let definitely_dead = *dead_process_generations
                .entry(entry.touched_process_generation.clone())
                .or_insert_with(|| process_definitely_dead(&entry.touched_process_generation));
            if !definitely_dead {
                retained.push(entry.claim.id.clone());
                return true;
            }
            match delete(&entry.claim.id) {
                Ok(()) => {
                    deleted.push(entry.claim.id.clone());
                    changed = true;
                    false
                }
                Err(error) => {
                    failures.push(SshCredentialCleanupFailure {
                        id: entry.claim.id.clone(),
                        error,
                    });
                    retained.push(entry.claim.id.clone());
                    true
                }
            }
        });
        Ok((
            SshCredentialCleanupReport {
                deleted,
                retained,
                failures,
            },
            changed,
        ))
    })
}

pub fn reconcile(
    live_claims: Vec<SshCredentialClaimV1>,
    referenced_ids: Vec<String>,
) -> Result<SshCredentialCleanupReport, String> {
    let generation = crate::secrets::ssh_credential_process_generation()?;
    reconcile_at(
        &registry_path()?,
        live_claims,
        referenced_ids,
        generation,
        crate::secrets::ssh_credential_process_generation_definitely_dead,
        crate::secrets::delete_ssh_secret,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn claim(id: char, generation: &str) -> SshCredentialClaimV1 {
        SshCredentialClaimV1 {
            schema_version: 1,
            id: format!("ssh-{}", id.to_string().repeat(32)),
            host_id: "host-1".to_string(),
            registration_generation: generation.to_string(),
        }
    }

    #[test]
    fn a_live_claim_is_never_retired_from_an_absence_only_snapshot() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join(REGISTRY_FILE_NAME);
        let credential = claim('a', "registration-1");
        transition_at(
            &path,
            vec![credential.clone()],
            "10:100",
            CredentialPhase::Staged,
        )
        .unwrap();
        transition_at(
            &path,
            vec![credential.clone()],
            "20:200",
            CredentialPhase::Live,
        )
        .unwrap();

        let mut deleted = Vec::new();
        let report = reconcile_at(
            &path,
            vec![],
            vec![],
            "30:300",
            |_| true,
            |id| {
                deleted.push(id.to_string());
                Ok(())
            },
        )
        .unwrap();

        assert!(deleted.is_empty());
        assert_eq!(report.retained, vec![credential.id]);
    }

    #[test]
    fn collection_deletes_and_acknowledges_under_one_registry_lock() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join(REGISTRY_FILE_NAME);
        let credential = claim('b', "registration-1");
        transition_at(
            &path,
            vec![credential.clone()],
            "10:100",
            CredentialPhase::Retiring,
        )
        .unwrap();

        let report = reconcile_at(&path, vec![], vec![], "20:200", |_| true, |_| Ok(())).unwrap();

        assert_eq!(report.deleted, vec![credential.id.clone()]);
        assert!(read_registry(&path).unwrap().entries.is_empty());
    }

    #[test]
    fn one_reconcile_probes_each_process_generation_once() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join(REGISTRY_FILE_NAME);
        transition_at(
            &path,
            vec![claim('v', "registration-1"), claim('w', "registration-2")],
            "10:100",
            CredentialPhase::Retiring,
        )
        .unwrap();
        let mut probes = 0;

        let report = reconcile_at(
            &path,
            vec![],
            vec![],
            "20:200",
            |_| {
                probes += 1;
                true
            },
            |_| Ok(()),
        )
        .unwrap();

        assert_eq!(probes, 1);
        assert_eq!(report.deleted.len(), 2);
    }

    #[test]
    fn failed_deletion_keeps_retryable_intent() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join(REGISTRY_FILE_NAME);
        let credential = claim('c', "registration-1");
        transition_at(
            &path,
            vec![credential.clone()],
            "10:100",
            CredentialPhase::Retiring,
        )
        .unwrap();

        let report = reconcile_at(
            &path,
            vec![],
            vec![],
            "20:200",
            |_| true,
            |_| Err("keychain unavailable".to_string()),
        )
        .unwrap();

        assert_eq!(report.retained, vec![credential.id]);
        assert_eq!(report.failures.len(), 1);
        assert_eq!(read_registry(&path).unwrap().entries.len(), 1);
    }

    #[test]
    fn legacy_references_touch_existing_owned_claims_without_claiming_legacy_ids() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join(REGISTRY_FILE_NAME);
        let credential = claim('d', "registration-1");
        transition_at(
            &path,
            vec![credential.clone()],
            "10:100",
            CredentialPhase::Retiring,
        )
        .unwrap();

        reconcile_at(
            &path,
            vec![],
            vec![credential.id.clone(), "legacy-shared".to_string()],
            "20:200",
            |_| false,
            |_| panic!("referenced credential must not be deleted"),
        )
        .unwrap();

        let registry = read_registry(&path).unwrap();
        assert_eq!(registry.entries.len(), 1);
        assert_eq!(registry.entries[0].claim, credential);
        assert_eq!(registry.entries[0].phase, CredentialPhase::Live);
        assert_eq!(registry.entries[0].touched_process_generation, "20:200");
    }

    #[test]
    fn malformed_and_duplicate_legacy_references_cannot_poison_reconciliation() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join(REGISTRY_FILE_NAME);
        let credential = claim('m', "registration-1");
        transition_at(
            &path,
            vec![credential.clone()],
            "10:100",
            CredentialPhase::Retiring,
        )
        .unwrap();
        let mut references = vec!["x".repeat(1_024)];
        references.extend(std::iter::repeat_n(credential.id.clone(), MAX_CLAIMS + 1));

        let report = reconcile_at(
            &path,
            vec![],
            references,
            "20:200",
            |_| true,
            |_| panic!("the valid referenced claim must be retained"),
        )
        .unwrap();

        assert_eq!(report.retained, vec![credential.id]);
    }

    #[test]
    fn an_interrupted_registry_replacement_is_recovered_before_mutation() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join(REGISTRY_FILE_NAME);
        let recovered = claim('r', "registration-1");
        let backup = RegistryV1 {
            version: REGISTRY_VERSION,
            entries: vec![RegistryEntryV1 {
                claim: recovered.clone(),
                touched_process_generation: "10:100".to_string(),
                phase: CredentialPhase::Retiring,
            }],
        };
        std::fs::write(
            temp.path().join(format!(".{REGISTRY_FILE_NAME}.backup")),
            serde_json::to_vec(&backup).unwrap(),
        )
        .unwrap();
        let added = claim('s', "registration-2");

        transition_at(
            &path,
            vec![added.clone()],
            "20:200",
            CredentialPhase::Staged,
        )
        .unwrap();

        let ids = read_registry(&path)
            .unwrap()
            .entries
            .into_iter()
            .map(|entry| entry.claim.id)
            .collect::<HashSet<_>>();
        assert_eq!(ids, HashSet::from([recovered.id, added.id]));
    }

    #[test]
    fn an_unknown_process_probe_never_grants_deletion_authority() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join(REGISTRY_FILE_NAME);
        let credential = claim('u', "registration-1");
        transition_at(
            &path,
            vec![credential.clone()],
            "10:100",
            CredentialPhase::Staged,
        )
        .unwrap();

        let report = reconcile_at(
            &path,
            vec![],
            vec![],
            "20:200",
            |_| false,
            |_| panic!("an unknown process must retain the credential"),
        )
        .unwrap();

        assert_eq!(report.retained, vec![credential.id]);
    }

    #[test]
    fn one_id_cannot_change_ownership() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join(REGISTRY_FILE_NAME);
        let first = claim('e', "registration-1");
        let mut conflicting = first.clone();
        conflicting.registration_generation = "registration-2".to_string();
        transition_at(&path, vec![first], "10:100", CredentialPhase::Staged).unwrap();

        assert_eq!(
            transition_at(&path, vec![conflicting], "20:200", CredentialPhase::Staged,),
            Err("ssh_credential_registry_identity_conflict".to_string())
        );
    }

    #[test]
    fn registry_bound_applies_across_multiple_batches() {
        let mut registry = RegistryV1 {
            version: REGISTRY_VERSION,
            entries: (0..MAX_CLAIMS)
                .map(|index| RegistryEntryV1 {
                    claim: SshCredentialClaimV1 {
                        schema_version: 1,
                        id: format!("ssh-{index:032}"),
                        host_id: format!("host-{index}"),
                        registration_generation: "registration-1".to_string(),
                    },
                    touched_process_generation: "10:100".to_string(),
                    phase: CredentialPhase::Live,
                })
                .collect(),
        };
        let extra = claim('z', "registration-extra");

        assert_eq!(
            transition_registry(&mut registry, &[extra], "20:200", CredentialPhase::Staged,),
            Err("ssh_credential_claims_too_large".to_string())
        );
        assert_eq!(registry.entries.len(), MAX_CLAIMS);
    }
}
