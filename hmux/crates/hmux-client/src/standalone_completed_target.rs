use crate::{
    ClientError, ExitedSessionRetirementFence, ExitedSessionRetirementGeneration,
    ExitedSessionRetirementProcessProof, LocalSessionCatalog, ProcessDescriptor, SessionClass,
    SessionDescriptor, StandaloneCreateReceipt, StandaloneCreateRequest,
};
use hmux_host::local_discovery::{ManifestLimits, workspace_id_for_path};
use serde::{Deserialize, Deserializer, Serialize};

/// Preserve the existing private journal representation across client and CLI
/// consumers. A schema rename would strand already completed operations.
pub const COMPLETED_STANDALONE_TARGET_SCHEMA: &str =
    "hmux-standalone-create-operation-completed-target-v1";
const COMPLETED_TARGET_SCHEMA: &str = COMPLETED_STANDALONE_TARGET_SCHEMA;
const COMPLETED_TARGET_SCHEMA_VERSION: u16 = 1;

/// The receipt and exact generation captured together at standalone creation.
/// Deserialize once at the journal boundary; consumers use the existing catalog
/// lifecycle operations with this target, never reconstruct it from a name.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(transparent)]
pub struct CompletedStandaloneTarget(CompletedStandaloneTargetRecord);

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CompletedStandaloneTargetRecord {
    schema: String,
    schema_version: u16,
    receipt: StandaloneCreateReceipt,
    generation: ExitedSessionRetirementGeneration,
    provider_process: ProcessDescriptor,
    host_build_version: String,
}

impl<'de> Deserialize<'de> for CompletedStandaloneTarget {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Self::try_from(CompletedStandaloneTargetRecord::deserialize(deserializer)?)
            .map_err(serde::de::Error::custom)
    }
}

impl TryFrom<CompletedStandaloneTargetRecord> for CompletedStandaloneTarget {
    type Error = ClientError;

    fn try_from(record: CompletedStandaloneTargetRecord) -> Result<Self, Self::Error> {
        record.receipt.validate().map_err(|_| invalid_target())?;
        if record.schema != COMPLETED_TARGET_SCHEMA
            || record.schema_version != COMPLETED_TARGET_SCHEMA_VERSION
            || record.generation.fence.session_id != record.receipt.session_id()
            || record.generation.fence.workspace_id != record.receipt.workspace_id()
            || record.provider_process.process_id == 0
            || record.provider_process.start_marker.is_empty()
            || record.host_build_version.is_empty()
        {
            return Err(invalid_target());
        }
        Ok(Self(record))
    }
}

impl CompletedStandaloneTarget {
    /// Decode a recovery checkpoint against its frozen request. A legacy
    /// receipt may recover the generation only from the exact creation key;
    /// neither a session name nor a new broker launch can supply that identity.
    pub fn from_recovery_checkpoint(
        catalog: &LocalSessionCatalog,
        request: &StandaloneCreateRequest,
        source: &str,
    ) -> Result<Self, ClientError> {
        let value: serde_json::Value =
            serde_json::from_str(source).map_err(|_| invalid_target())?;
        if value.get("schema").and_then(serde_json::Value::as_str) == Some(COMPLETED_TARGET_SCHEMA)
        {
            let target: Self = serde_json::from_value(value).map_err(|_| invalid_target())?;
            validate_recovery_receipt(catalog.discovery_paths(), request, target.receipt())?;
            return Ok(target);
        }
        let receipt: StandaloneCreateReceipt =
            serde_json::from_value(value).map_err(|_| invalid_target())?;
        receipt.validate().map_err(|_| invalid_target())?;
        validate_recovery_receipt(catalog.discovery_paths(), request, &receipt)?;
        let identity = request.recovery_identity().ok_or_else(invalid_target)?;
        let session = LocalSessionCatalog::new(receipt.discovery_root())
            .find_creation(
                receipt.workspace_id(),
                receipt.session_id(),
                &crate::standalone_create_idempotency_key(identity),
            )?
            .ok_or_else(|| {
                ClientError::transport(
                    "hmux_standalone_recovery_target_unavailable",
                    "legacy recovery's exact creation is unavailable",
                )
            })?;
        Self::from_created(receipt, session.descriptor())
    }

    /// Largest completion shape permitted by the descriptor boundary. A NUL
    /// byte has the greatest expansion through checkpoint JSON nested in the
    /// journal; a backslash does the same for the control-free record fields.
    pub fn capacity_witness(
        catalog: &LocalSessionCatalog,
        request: &StandaloneCreateRequest,
    ) -> Result<Self, ClientError> {
        let recovery = request.recovery_identity().ok_or_else(invalid_target)?;
        let session_name = request.session_name().ok_or_else(invalid_target)?;
        let workspace_id = workspace_id_for_path(request.provider_cwd());
        let largest_identifier = "\0".repeat(ManifestLimits::default().max_identifier_bytes);
        let largest_record_identifier = "\\".repeat(ManifestLimits::default().max_identifier_bytes);
        let receipt = StandaloneCreateReceipt::new(
            recovery.target_session_id(),
            workspace_id.clone(),
            session_name,
            catalog.discovery_root(),
            recovery.launch_owner_proof(),
        )
        .map_err(|_| invalid_target())?;
        let target = CompletedStandaloneTargetRecord {
            schema: COMPLETED_TARGET_SCHEMA.to_string(),
            schema_version: COMPLETED_TARGET_SCHEMA_VERSION,
            receipt,
            generation: ExitedSessionRetirementGeneration {
                fence: ExitedSessionRetirementFence {
                    workspace_id,
                    session_id: recovery.target_session_id().to_string(),
                    runner_principal: largest_identifier.clone(),
                    runner_instance: largest_identifier.clone(),
                    channel_epoch: u64::MAX.to_string(),
                    host_instance_id: largest_identifier.clone(),
                    terminal_epoch: largest_identifier.clone(),
                },
                host_process: ExitedSessionRetirementProcessProof {
                    process_id: u32::MAX,
                    start_marker: largest_identifier.clone(),
                },
            },
            provider_process: ProcessDescriptor {
                process_id: u32::MAX,
                start_marker: largest_identifier.clone(),
            },
            host_build_version: largest_record_identifier,
        };
        Self::try_from(target)
    }

    pub fn from_created(
        receipt: StandaloneCreateReceipt,
        descriptor: &SessionDescriptor,
    ) -> Result<Self, ClientError> {
        if descriptor.session_class != SessionClass::Standalone
            || descriptor.session_name.as_deref() != Some(receipt.session_name())
            || descriptor.session_id != receipt.session_id()
            || descriptor.workspace_id != receipt.workspace_id()
        {
            return Err(invalid_target());
        }
        let target = CompletedStandaloneTargetRecord {
            schema: COMPLETED_TARGET_SCHEMA.to_string(),
            schema_version: COMPLETED_TARGET_SCHEMA_VERSION,
            receipt,
            generation: ExitedSessionRetirementGeneration::from_descriptor(descriptor)?,
            provider_process: descriptor.provider_process.clone(),
            host_build_version: descriptor.host_build_version.clone(),
        };
        Self::try_from(target)
    }

    pub fn receipt(&self) -> &StandaloneCreateReceipt {
        &self.0.receipt
    }

    pub fn generation(&self) -> &ExitedSessionRetirementGeneration {
        &self.0.generation
    }

    pub fn provider_process(&self) -> &ProcessDescriptor {
        &self.0.provider_process
    }

    pub fn host_build_version(&self) -> &str {
        &self.0.host_build_version
    }
}

fn invalid_target() -> ClientError {
    ClientError::transport(
        "hmux_standalone_create_operation_invalid",
        "saved standalone target is invalid",
    )
}

/// Bind a receipt to its operation's prepared request and writable namespace.
/// The completed-target decoder separately permits configured historical roots;
/// a lookup namespace does not authorize a fresh launch.
pub fn validate_standalone_recovery_receipt(
    catalog: &LocalSessionCatalog,
    request: &StandaloneCreateRequest,
    receipt: &StandaloneCreateReceipt,
) -> Result<(), ClientError> {
    validate_recovery_receipt(std::iter::once(catalog.discovery_root()), request, receipt)
}

fn validate_recovery_receipt<'a>(
    mut roots: impl Iterator<Item = &'a std::path::Path>,
    request: &StandaloneCreateRequest,
    receipt: &StandaloneCreateReceipt,
) -> Result<(), ClientError> {
    let recovery = request.recovery_identity().ok_or_else(invalid_target)?;
    if request.session_name() != Some(receipt.session_name())
        || recovery.target_session_id() != receipt.session_id()
        || recovery.launch_owner_proof() != receipt.launch_owner_proof()
        || !roots.any(|root| root == receipt.discovery_root())
    {
        return Err(invalid_target());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // This is the already shipped CLI checkpoint shape, not serialization of
    // the new wrapper. Loading it must retain exact retirement authority.
    fn legacy_checkpoint() -> serde_json::Value {
        serde_json::json!({
            "schema": "hmux-standalone-create-operation-completed-target-v1",
            "schemaVersion": 1,
            "receipt": StandaloneCreateReceipt::new(
                "session", "workspace", "name", "/fixture-discovery", "fixture-proof",
            ).unwrap(),
            "generation": {
                "fence": {
                    "workspaceId": "workspace", "sessionId": "session",
                    "runnerPrincipal": "principal", "runnerInstance": "runner",
                    "channelEpoch": "1", "hostInstanceId": "host", "terminalEpoch": "terminal",
                },
                "hostProcess": {"processId": 21, "startMarker": "exact-host-generation"},
            },
            "providerProcess": {"process_id": 22, "start_marker": "exact-provider-generation"},
            "hostBuildVersion": "build",
        })
    }

    #[test]
    fn legacy_checkpoint_retains_its_receipt_and_exact_generation() {
        let saved = legacy_checkpoint();
        let target: CompletedStandaloneTarget = serde_json::from_value(saved.clone()).unwrap();
        assert_eq!(target.receipt().session_id(), "session");
        assert_eq!(
            target.generation().host_process.start_marker,
            "exact-host-generation"
        );
        assert_eq!(
            target.provider_process().start_marker,
            "exact-provider-generation"
        );
        assert_eq!(serde_json::to_value(target).unwrap(), saved);
    }

    #[test]
    fn inconsistent_receipt_cannot_become_a_completed_target() {
        let mut saved = legacy_checkpoint();
        serde_json::from_value::<CompletedStandaloneTarget>(saved.clone()).unwrap();
        saved["generation"]["fence"]["sessionId"] = "another-session".into();
        assert!(serde_json::from_value::<CompletedStandaloneTarget>(saved).is_err());
    }

    #[cfg(feature = "local-runtime")]
    #[test]
    fn configured_history_keeps_its_namespace_without_authorizing_new_launches_there() {
        let mut saved = legacy_checkpoint();
        saved["receipt"]["sessionId"] = "standalone_history".into();
        saved["generation"]["fence"]["sessionId"] = "standalone_history".into();
        let request = StandaloneCreateRequest::new(
            "/fixture-workspace",
            Some("name".into()),
            vec!["/bin/sh".into()],
            24,
            80,
        )
        .unwrap()
        .with_recovery_identity(
            crate::StandaloneRecoveryCreateIdentity::new("standalone_history", "fixture-proof")
                .unwrap(),
        )
        .unwrap();
        let catalog = LocalSessionCatalog::with_read_only_discovery_roots(
            "/new-primary",
            vec!["/fixture-discovery".into()],
        )
        .unwrap();
        let target = CompletedStandaloneTarget::from_recovery_checkpoint(
            &catalog,
            &request,
            &saved.to_string(),
        )
        .unwrap();
        assert_eq!(serde_json::to_value(&target).unwrap(), saved);
        assert!(
            validate_standalone_recovery_receipt(&catalog, &request, target.receipt()).is_err()
        );
        assert!(
            validate_standalone_recovery_receipt(
                &LocalSessionCatalog::new("/fixture-discovery"),
                &request,
                target.receipt(),
            )
            .is_ok()
        );
        assert!(
            CompletedStandaloneTarget::from_recovery_checkpoint(
                &LocalSessionCatalog::new("/unconfigured"),
                &request,
                &saved.to_string(),
            )
            .is_err()
        );
    }
}
