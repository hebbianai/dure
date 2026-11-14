use super::{ManagedCreateLedgerRecord, ManagedCreateLedgerRecordState};
use hmux_host::local_discovery::{
    DiscoveryError, DiscoveryKey, DiscoveryManifest, DiscoveryRoot, ReadyManifest, SessionClass,
};
use hmux_runtime_contract::{ManagedCreateGenerationFence, ManagedCreateReceipt};
use hmux_session_protocol::SessionFence;
use std::path::Path;

fn discovery_error(error: DiscoveryError) -> String {
    format!("hmux_managed_create_ledger_invalid: conversation writer discovery: {error}")
}

/// Admission and Host exit checkpointing share one proof. Archival changes
/// where the immutable tombstone lives, not whether its exact writer exited.
pub(super) fn completed_conversation_writer_has_exited(
    discovery_root: &Path,
    record: &ManagedCreateLedgerRecord,
) -> Result<bool, String> {
    let ManagedCreateLedgerRecordState::Completed {
        receipt: serialized,
        retired: false,
        ..
    } = &record.state
    else {
        return Ok(false);
    };
    let receipt: ManagedCreateReceipt = serde_json::from_str(serialized).map_err(|_| {
        "hmux_managed_create_ledger_invalid: conversation writer receipt is malformed".to_string()
    })?;
    receipt.validate().map_err(|error| {
        format!("hmux_managed_create_ledger_invalid: conversation writer receipt: {error}")
    })?;
    let fence = receipt.generation_fence().ok_or_else(|| {
        "hmux_managed_create_ledger_invalid: conversation writer receipt has no generation fence"
            .to_string()
    })?;
    if receipt.workspace_id() != record.workspace_id
        || receipt.session_id() != record.session_id
        || receipt.discovery_root() != discovery_root
        || record
            .conversation_identity
            .as_ref()
            .is_some_and(|identity| identity.provider_id() != receipt.provider_id())
    {
        return Err(
            "hmux_managed_create_ledger_invalid: conversation writer receipt changed identity"
                .to_string(),
        );
    }
    let root = DiscoveryRoot::open(discovery_root).map_err(discovery_error)?;
    let key = DiscoveryKey::new(
        &record.workspace_id,
        &record.session_id,
        fence.runner_instance(),
        fence.channel_epoch(),
    )
    .map_err(|error| format!("hmux_managed_create_ledger_invalid: {error}"))?;
    let Some(session) = root.open_session_if_present(key).map_err(discovery_error)? else {
        return Ok(false);
    };
    let exited = match session
        .read_manifest_if_present()
        .map_err(discovery_error)?
    {
        Some(DiscoveryManifest::Exited(exited)) => exited,
        // A reboot or crash ends the Host before it can publish its tombstone.
        Some(DiscoveryManifest::Ready(ready)) => {
            return Ok(ready_writer_is_gone(record, &receipt, fence, &ready));
        }
        Some(_) => return Ok(false),
        None => {
            let expected = SessionFence {
                workspace_id: record.workspace_id.clone(),
                session_id: record.session_id.clone(),
                runner_principal: fence.runner_principal().to_string(),
                runner_instance: fence.runner_instance().to_string(),
                channel_epoch: fence.channel_epoch(),
                host_instance_id: fence.host_instance_id().to_string(),
                terminal_epoch: fence.terminal_epoch().to_string(),
            };
            let Some(exited) = session
                .find_retired_exited_fenced(&expected)
                .map_err(discovery_error)?
            else {
                // Missing discovery alone is never proof that a writer exited.
                return Ok(false);
            };
            exited
        }
    };
    let common = &exited.common;
    if common.session_class != SessionClass::Managed
        || common.provider_id != receipt.provider_id()
        || common.claim_linkage.kickoff_action_id.as_deref()
            != Some(record.idempotency_key.as_str())
        || !fence.matches_generation(
            &common.lifetime.runner_principal,
            &common.lifetime.runner_instance,
            &common.lifetime.channel_epoch.to_string(),
            &common.host_instance_id,
            &exited.tombstone.fence.terminal_epoch,
        )
    {
        return Err(
            "hmux_managed_create_ledger_invalid: exited conversation writer generation changed"
                .to_string(),
        );
    }
    Ok(true)
}

/// A Ready manifest is the writer's own generation until its Host publishes an
/// exit. When that Host died without one, as every Host does in a reboot, the
/// writer is gone only if the OS proves both the exact Host generation and the
/// provider's whole process session are gone. Anything less, including a
/// different generation or an unobservable process table, keeps the claim.
fn ready_writer_is_gone(
    record: &ManagedCreateLedgerRecord,
    receipt: &ManagedCreateReceipt,
    fence: &ManagedCreateGenerationFence,
    ready: &ReadyManifest,
) -> bool {
    let common = &ready.common;
    if common.session_class != SessionClass::Managed
        || common.provider_id != receipt.provider_id()
        || common.claim_linkage.kickoff_action_id.as_deref()
            != Some(record.idempotency_key.as_str())
        || !fence.matches_generation(
            &common.lifetime.runner_principal,
            &common.lifetime.runner_instance,
            &common.lifetime.channel_epoch.to_string(),
            &common.host_instance_id,
            &ready.terminal_epoch,
        )
    {
        return false;
    }
    host_and_provider_session_are_gone(ready)
}

#[cfg(all(unix, feature = "local-runtime"))]
fn host_and_provider_session_are_gone(ready: &ReadyManifest) -> bool {
    use crate::{
        LocalProcessGenerationStatus, ProcessDescriptor, local_process_session_is_stably_empty,
        probe_local_process_generation,
    };
    let host = ProcessDescriptor {
        process_id: ready.common.host_process.process_id,
        start_marker: ready.common.host_process.start_marker.clone(),
    };
    let provider = ProcessDescriptor {
        process_id: ready.provider_process.process_id,
        start_marker: ready.provider_process.start_marker.clone(),
    };
    matches!(
        probe_local_process_generation(&host),
        Ok(LocalProcessGenerationStatus::Absent)
    ) && local_process_session_is_stably_empty(&provider).unwrap_or(false)
}

/// Without a POSIX session census the provider cannot be proven gone; such a
/// writer is released only by its Host's own exit tombstone.
#[cfg(not(all(unix, feature = "local-runtime")))]
fn host_and_provider_session_are_gone(_ready: &ReadyManifest) -> bool {
    false
}
