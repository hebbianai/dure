use super::{
    ManagedCreateAdmissionError, ManagedCreateLedgerState, ManagedCreateLineageContext,
    reserve_with_lineage_admission,
};
use crate::recovery_journal::request_fingerprint;
use hmux_runtime_contract::{
    ManagedCreateRequest, ManagedRehostSourceRecipe, ProviderConversationIdentitySeed,
};
use std::path::Path;

#[cfg(all(test, feature = "local-runtime"))]
mod tests;

/// Selects root admission or an already-authorized successor edge. This is
/// caller-side ledger authority, never a hint supplied over the create wire.
#[derive(Clone, Copy)]
pub enum ManagedCreateLineageAdmission {
    Root,
    Successor,
}

/// Reserves the exact request without launching a broker, Host, or provider.
/// The caller may durably acquire its own resources after this reservation and
/// before create. Cancellation uses the existing identity-only chain stop.
/// A reservation is not process liveness or permission to reopen a retired
/// identity; the runtime reuses this same admission when it receives create.
pub fn reserve_request(
    discovery_root: &Path,
    request: &ManagedCreateRequest,
    lineage: ManagedCreateLineageAdmission,
) -> Result<ManagedCreateLedgerState, ManagedCreateAdmissionError> {
    admit_request(discovery_root, request, lineage, false)
}

/// Reserve a root's immutable create identity before external resources are
/// acquired. The existing writer may remain alive until replacement executes.
/// This never grants permission to spawn or write to the conversation.
pub fn prepare_root_request(
    discovery_root: &Path,
    request: &ManagedCreateRequest,
) -> Result<(), ManagedCreateAdmissionError> {
    match admit_request(
        discovery_root,
        request,
        ManagedCreateLineageAdmission::Root,
        true,
    )? {
        ManagedCreateLedgerState::Retired => {
            Err(ManagedCreateAdmissionError::GenerationRetiredExact)
        }
        _ => Ok(()),
    }
}

fn admit_request(
    discovery_root: &Path,
    request: &ManagedCreateRequest,
    lineage: ManagedCreateLineageAdmission,
    defer_writer: bool,
) -> Result<ManagedCreateLedgerState, ManagedCreateAdmissionError> {
    request.validate().map_err(|error| error.to_string())?;
    let serialized = request
        .canonical_create_identity_json()
        .map_err(|error| format!("managed create request digest failed: {error}"))?;
    let digest = request_fingerprint(&[&serialized]);
    let rehost_recipe = ManagedRehostSourceRecipe::from_create_request(request)
        .map_err(|error| error.to_string())?
        .map(|recipe| {
            serde_json::to_string(&recipe)
                .map_err(|error| format!("managed rehost recipe encode failed: {error}"))
        })
        .transpose()?;
    let context = ManagedCreateLineageContext {
        canonical_rehost_recipe: rehost_recipe.as_deref(),
        conversation_identity: request.conversation_identity(),
        admission: lineage,
    };
    if defer_writer {
        return super::reservation::prepare_request_metadata(
            discovery_root,
            (
                request.workspace_id(),
                request.session_id(),
                request.idempotency_key(),
            ),
            &digest,
            context,
        );
    }
    reserve_with_lineage_admission(
        discovery_root,
        request.workspace_id(),
        request.session_id(),
        request.idempotency_key(),
        &digest,
        context,
    )
}

pub fn reserve(
    discovery_root: &Path,
    workspace_id: &str,
    session_id: &str,
    idempotency_key: &str,
    request_digest: &str,
) -> Result<ManagedCreateLedgerState, String> {
    reserve_with_rehost_recipe(
        discovery_root,
        workspace_id,
        session_id,
        idempotency_key,
        request_digest,
        None,
    )
}

/// Permanently binds one logical managed session to both its create digest and
/// an owner-only, non-secret rehost recipe. The original launch command is
/// intentionally not stored here.
pub fn reserve_with_rehost_recipe(
    discovery_root: &Path,
    workspace_id: &str,
    session_id: &str,
    idempotency_key: &str,
    request_digest: &str,
    canonical_rehost_recipe: Option<&str>,
) -> Result<ManagedCreateLedgerState, String> {
    reserve_with_rehost_recipe_and_conversation(
        discovery_root,
        workspace_id,
        session_id,
        idempotency_key,
        request_digest,
        canonical_rehost_recipe,
        None,
    )
    .map_err(|error| error.to_string())
}

pub(super) fn decode_canonical_rehost_recipe(
    serialized: &str,
    workspace_id: &str,
    session_id: &str,
) -> Result<ManagedRehostSourceRecipe, String> {
    let recipe: ManagedRehostSourceRecipe = serde_json::from_str(serialized).map_err(|_| {
        "hmux_managed_create_ledger_invalid: canonical rehost recipe is malformed".to_string()
    })?;
    recipe.validate().map_err(|error| {
        format!("hmux_managed_create_ledger_invalid: canonical rehost recipe: {error}")
    })?;
    if recipe.workspace_id() != workspace_id || recipe.session_id() != session_id {
        return Err(
            "hmux_managed_create_ledger_invalid: canonical rehost recipe identity changed"
                .to_string(),
        );
    }
    Ok(recipe)
}

/// Admits one exact provider conversation writer through the same durable
/// lifecycle record that owns the managed create. Requests without an exact
/// conversation retain the legacy per-logical-session behavior.
pub fn reserve_with_rehost_recipe_and_conversation(
    discovery_root: &Path,
    workspace_id: &str,
    session_id: &str,
    idempotency_key: &str,
    request_digest: &str,
    canonical_rehost_recipe: Option<&str>,
    conversation_identity: Option<&ProviderConversationIdentitySeed>,
) -> Result<ManagedCreateLedgerState, ManagedCreateAdmissionError> {
    reserve_with_lineage_admission(
        discovery_root,
        workspace_id,
        session_id,
        idempotency_key,
        request_digest,
        ManagedCreateLineageContext {
            canonical_rehost_recipe,
            conversation_identity,
            admission: ManagedCreateLineageAdmission::Root,
        },
    )
}

/// Admits a create that is already named by a managed-create successor edge.
/// The origin is internal broker authority, not a wire option: a missing
/// predecessor absence is authoritative only after the one-time retained
/// topology cutover has fenced old writers and indexed every frozen forward
/// shard; it can never be guessed to be a graph root.
pub fn reserve_successor_with_rehost_recipe_and_conversation(
    discovery_root: &Path,
    workspace_id: &str,
    session_id: &str,
    idempotency_key: &str,
    request_digest: &str,
    canonical_rehost_recipe: Option<&str>,
    conversation_identity: Option<&ProviderConversationIdentitySeed>,
) -> Result<ManagedCreateLedgerState, ManagedCreateAdmissionError> {
    reserve_with_lineage_admission(
        discovery_root,
        workspace_id,
        session_id,
        idempotency_key,
        request_digest,
        ManagedCreateLineageContext {
            canonical_rehost_recipe,
            conversation_identity,
            admission: ManagedCreateLineageAdmission::Successor,
        },
    )
}
