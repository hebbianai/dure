use super::RecoveryOperationCheckpoint;
use crate::{StandaloneCreateRequest, StandaloneReplacementSource};
use serde::{Deserialize, Serialize, de::DeserializeOwned};

mod admission;
pub(super) mod cancellation;
mod compacted;
mod observation;
mod reconciliation;

pub use cancellation::CANCELLED_CODE;
pub use observation::{read_completed, read_operation, read_successor};
pub use reconciliation::{PendingStandaloneUpgrade, complete_target, resolve_target};

pub(super) use admission::admit_prepared;
pub(super) use admission::prepared_location;
pub(super) use compacted::refuse_new_operation;

#[cfg(test)]
mod tests;

pub const SELECTED_BUILD_ACTION: &str = "upgrade_standalone_with_selected_build_v1";
pub const CURRENT_BUILD_ACTION: &str = "upgrade_standalone_with_current_build";

/// Runtime-owned replacement inputs. Each consumer retains its own launch
/// context alongside them without creating another copy of the request.
/// The wire shape also reads existing current-build upgrade checkpoints.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreparedStandaloneUpgrade<Context> {
    pub source: StandaloneReplacementSource,
    pub source_build_id: String,
    pub target_build_id: String,
    pub replacement: Option<StandaloneUpgradeReplacement<Context>>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StandaloneUpgradeReplacement<Context> {
    pub create: StandaloneCreateRequest,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub discovery_root: Option<std::path::PathBuf>,
    #[serde(flatten)]
    pub context: Context,
}

impl<Context> StandaloneUpgradeReplacement<Context> {
    /// Old envelopes used their operation namespace for creation. New
    /// cross-namespace intent freezes its destination before source retirement.
    pub fn discovery_root<'a>(
        &'a self,
        operation_root: &'a std::path::Path,
    ) -> &'a std::path::Path {
        self.discovery_root.as_deref().unwrap_or(operation_root)
    }
}

impl<Context: DeserializeOwned> PreparedStandaloneUpgrade<Context> {
    pub fn read(checkpoint: &RecoveryOperationCheckpoint) -> Result<Self, String> {
        let prepared: Self = serde_json::from_str(&checkpoint.canonical_payload).map_err(|_| {
            "hmux_recovery_journal_invalid: upgrade inputs are malformed".to_string()
        })?;
        if let Some(replacement) = &prepared.replacement {
            if replacement
                .discovery_root
                .as_ref()
                .is_some_and(|root| !root.is_absolute())
            {
                return Err(
                    "hmux_recovery_journal_invalid: upgrade destination must be absolute".into(),
                );
            }
            replacement
                .create
                .validate()
                .map_err(|error| error.to_string())?;
            let predecessor = prepared.source.presentation_predecessor()?;
            if replacement
                .create
                .recovery_identity()
                .and_then(|identity| identity.source_predecessor())
                != Some(&predecessor)
            {
                return Err(
                    "hmux_recovery_journal_invalid: upgrade target belongs to another source"
                        .into(),
                );
            }
        }
        Ok(prepared)
    }
}

/// Lineage and launch readers consume runtime facts, never the caller's
/// checkout binding, executable resolver or other adapter-owned context.
pub type ObservedStandaloneUpgrade =
    PreparedStandaloneUpgrade<std::collections::BTreeMap<String, serde::de::IgnoredAny>>;

pub fn read_upgrade(
    action: &str,
    checkpoint: &RecoveryOperationCheckpoint,
) -> Result<Option<ObservedStandaloneUpgrade>, String> {
    match action {
        SELECTED_BUILD_ACTION | CURRENT_BUILD_ACTION => {
            ObservedStandaloneUpgrade::read(checkpoint).map(Some)
        }
        _ => Ok(None),
    }
}

pub enum StandaloneUpgradeProgress {
    Pending(Box<PendingStandaloneUpgrade>),
    Completed(Box<StandaloneUpgradeSuccessor>),
    Cancelled,
}

/// One journal observation across pending execution and compacted history.
/// The pending handle retains the original operation namespace and writer.
pub enum StandaloneUpgradeOperation {
    Pending(Box<PendingStandaloneUpgrade>),
    Rehosted(Box<CompletedStandaloneUpgrade>),
    Cancelled,
}

/// The durable replacement fact outlives the launch inputs. Checkout owners
/// need only this exact identity to transfer or finish their retained claim.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StandaloneUpgradeSuccessor {
    pub creation_key: String,
    pub target: crate::CompletedStandaloneTarget,
}

/// A completed replacement is a runtime fact, not a request to launch again.
/// Replaying it does not require the caller's original executable or checkout.
#[derive(Eq, PartialEq)]
pub struct CompletedStandaloneUpgrade {
    pub source: StandaloneReplacementSource,
    pub source_build_id: String,
    pub successor: StandaloneUpgradeSuccessor,
}

impl StandaloneUpgradeSuccessor {
    fn from_launch(
        request: &StandaloneCreateRequest,
        target: crate::CompletedStandaloneTarget,
    ) -> Result<Self, String> {
        let identity = request.recovery_identity().ok_or_else(|| {
            "hmux_recovery_journal_invalid: upgrade launch identity is missing".to_string()
        })?;
        Ok(Self {
            creation_key: crate::standalone_create_idempotency_key(identity),
            target,
        })
    }
}

fn completed_launch(
    catalog: &crate::LocalSessionCatalog,
    record: &super::RecoveryRecord,
) -> Result<Option<(ObservedStandaloneUpgrade, crate::CompletedStandaloneTarget)>, String> {
    let super::RecoveryRecordState::Completed {
        target_session_id,
        target_workspace_id,
        target_build_id,
        outcome,
        operation_checkpoint: Some(checkpoint),
        ..
    } = &record.state
    else {
        return Ok(None);
    };
    let Some(prepared) = read_upgrade(&record.action, checkpoint)? else {
        return Ok(None);
    };
    let Some(replacement) = &prepared.replacement else {
        return Ok(None);
    };
    let target_catalog = replacement
        .discovery_root
        .as_ref()
        .map(crate::LocalSessionCatalog::new);
    let catalog = target_catalog.as_ref().unwrap_or(catalog);
    let saved = checkpoint.replacement_receipt.as_deref().ok_or_else(|| {
        "hmux_recovery_journal_invalid: completed upgrade has no target".to_string()
    })?;
    let target = crate::CompletedStandaloneTarget::from_recovery_checkpoint(
        catalog,
        &replacement.create,
        saved,
    )
    .map_err(|error| error.to_string())?;
    if outcome != "rehosted"
        || target.receipt().session_id() != target_session_id
        || target.receipt().workspace_id() != target_workspace_id
        || target.host_build_version() != target_build_id
        || target.host_build_version() != prepared.target_build_id
        || prepared.source.generation().fence.session_id != record.source_session_id
        || prepared.source.generation().fence.workspace_id != record.source_workspace_id
    {
        return Err("hmux_recovery_journal_invalid: upgrade completion changed its target".into());
    }
    Ok(Some((prepared, target)))
}

pub(super) fn publish_completion(
    directory: &std::path::Path,
    record: &super::RecoveryRecord,
) -> Result<(), String> {
    compacted::publish(directory, record)
}

/// The caller already owns journal admission; this is the same launch reader's
/// compacted storage path, not another provider recipe or launch authority.
pub(super) fn read_compacted_launch(
    directory: &std::path::Path,
    generation: &crate::ExitedSessionRetirementGeneration,
    provider: &crate::ProcessDescriptor,
) -> Result<Option<StandaloneCreateRequest>, String> {
    compacted::launch(directory, generation, provider)
}

/// Exact runtime retirement is the only authority allowed to discard launch
/// inputs. Compact source/target facts remain available to delayed resource owners.
pub(crate) fn retire_launch_inputs(
    catalog: &crate::LocalSessionCatalog,
    generation: &crate::ExitedSessionRetirementGeneration,
    provider: &crate::ProcessDescriptor,
) -> Result<(), String> {
    let mut roots: Vec<_> = catalog
        .discovery_paths()
        .map(std::path::Path::to_path_buf)
        .collect();
    let mut visited = std::collections::BTreeSet::new();
    while let Some(root) = roots.pop() {
        if !visited.insert(root.clone()) {
            continue;
        }
        let directory = root.join(".recovery");
        if !super::private_directory_exists(&directory)? {
            continue;
        }
        let _admission = super::acquire_admission_lock(&directory)?;
        if let Some(source_root) = compacted::retire_launch(&directory, generation, provider)? {
            roots.push(source_root);
        }
    }
    Ok(())
}
