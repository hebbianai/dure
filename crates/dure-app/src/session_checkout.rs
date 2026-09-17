//! Product-owned checkout bindings for session and recovery lifetimes.
//!
//! Adapters supply their already-parsed runtime or journal identity and canonical
//! namespace. These records retain a resource selection, not process liveness,
//! successor topology, or Git membership authority.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{AgentIdV1, GitCheckoutRegistrationV1, OperationIdV1};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum SessionCheckoutOwnerV1 {
    Managed {
        workspace_id: String,
        session_id: String,
        idempotency_key: String,
    },
    Standalone {
        workspace_id: String,
        session_id: String,
        /// The runtime's non-secret recovery-create key, not a pane or name.
        recovery_id: String,
    },
    /// An existing recovery journal owns retention between runtime lifetimes.
    /// It is not a fabricated session or an independently restartable create.
    Recovery { recovery_id: String },
    /// A backend Agent retains its resource across native and structured
    /// runtime replacements. Registration distinguishes Agent incarnations.
    Agent {
        agent_id: AgentIdV1,
        registration_id: OperationIdV1,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCheckoutIdentityV1 {
    pub runtime_namespace: String,
    pub owner: SessionCheckoutOwnerV1,
}

impl SessionCheckoutIdentityV1 {
    /// Indexed current owner. A transferred Git claim keeps its original ID.
    pub fn owner_id(&self) -> OperationIdV1 {
        let mut digest = Sha256::new();
        let (session, operation): (Option<(&str, &str)>, &str) = match &self.owner {
            SessionCheckoutOwnerV1::Managed {
                workspace_id,
                session_id,
                idempotency_key,
            } => {
                digest.update(b"dure-session-checkout-claim-v1\0");
                (Some((workspace_id, session_id)), idempotency_key)
            }
            SessionCheckoutOwnerV1::Standalone {
                workspace_id,
                session_id,
                recovery_id,
            } => {
                digest.update(b"dure-standalone-checkout-owner-v1\0");
                (Some((workspace_id, session_id)), recovery_id)
            }
            SessionCheckoutOwnerV1::Recovery { recovery_id } => {
                digest.update(b"dure-recovery-checkout-owner-v1\0");
                (None, recovery_id)
            }
            SessionCheckoutOwnerV1::Agent {
                agent_id,
                registration_id,
            } => {
                digest.update(b"dure-agent-checkout-owner-v1\0");
                digest.update((agent_id.as_str().len() as u64).to_le_bytes());
                digest.update(agent_id.as_str().as_bytes());
                (None, registration_id.as_str())
            }
        };
        let mut append = |field: &str| {
            digest.update((field.len() as u64).to_le_bytes());
            digest.update(field.as_bytes());
        };
        append(&self.runtime_namespace);
        if let Some((workspace_id, session_id)) = session {
            append(workspace_id);
            append(session_id);
        }
        append(operation);
        OperationIdV1::new(format!("session-checkout-{:x}", digest.finalize()))
            .expect("a fixed prefix and SHA-256 form a valid operation identity")
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCheckoutBindingV1 {
    /// Immutable resource identity; changing the runtime owner cannot release
    /// and reacquire this Git claim through a removal-admission gap.
    pub claim_id: OperationIdV1,
    pub identity: SessionCheckoutIdentityV1,
    pub working_directory: String,
    /// None retains the working directory without exact Git identity. It stays
    /// frozen across retries under the shared directory-use removal authority.
    pub registration: Option<GitCheckoutRegistrationV1>,
}

impl SessionCheckoutBindingV1 {
    /// A fresh Agent incarnation allocates one prospective Native root. An
    /// adopted claim retains its historical origin instead of allocating again.
    pub fn registered_agent_native_origin(
        &self,
        runtime_workspace_id: &str,
    ) -> Option<SessionCheckoutIdentityV1> {
        if !matches!(self.identity.owner, SessionCheckoutOwnerV1::Agent { .. })
            || self.claim_id != self.identity.owner_id()
        {
            return None;
        }
        Some(SessionCheckoutIdentityV1 {
            runtime_namespace: self.identity.runtime_namespace.clone(),
            owner: SessionCheckoutOwnerV1::Managed {
                workspace_id: runtime_workspace_id.into(),
                session_id: self.claim_id.as_str().into(),
                idempotency_key: self.claim_id.as_str().into(),
            },
        })
    }

    /// Describe the retained Agent owner without transferring or reacquiring
    /// the immutable claim. The caller's lifecycle transaction admits the move.
    pub fn retained_by_agent(&self, agent_id: &AgentIdV1) -> Self {
        if matches!(&self.identity.owner, SessionCheckoutOwnerV1::Agent { agent_id: owner, .. } if owner == agent_id)
        {
            return self.clone();
        }
        Self {
            identity: SessionCheckoutIdentityV1 {
                runtime_namespace: self.identity.runtime_namespace.clone(),
                owner: SessionCheckoutOwnerV1::Agent {
                    agent_id: agent_id.clone(),
                    registration_id: self.claim_id.clone(),
                },
            },
            ..self.clone()
        }
    }

    pub fn new(
        identity: SessionCheckoutIdentityV1,
        working_directory: String,
        registration: Option<GitCheckoutRegistrationV1>,
    ) -> Self {
        Self {
            claim_id: identity.owner_id(),
            identity,
            working_directory,
            registration,
        }
    }
}

/// Whether this product operation may acquire its checkout claim. Closing is
/// durable before runtime stop; Closed is recorded only after exact cleanup.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SessionCheckoutAdmissionV1 {
    Open,
    Closing,
    Closed,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionCheckoutRecordV1 {
    pub binding: SessionCheckoutBindingV1,
    pub admission: SessionCheckoutAdmissionV1,
    /// Immutable runtime command input retained before close. The selected
    /// runtime parses it and remains the only authority for retirement; this
    /// payload is not a cached liveness decision.
    pub close_payload: Option<serde_json::Value>,
}

/// Permanent Agent removal composes the existing runtime close and resource
/// lifetimes. Freeze these inputs before stopping a provider; retry never
/// discovers a different checkout or reconstructs a retired native origin.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentRuntimeRemovalPlanV1 {
    pub checkout: Option<SessionCheckoutBindingV1>,
    pub managed_roots: Vec<SessionCheckoutIdentityV1>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentRuntimeRemovalV1 {
    pub schema_version: u16,
    pub plan: AgentRuntimeRemovalPlanV1,
    /// Runtime Stopped does not imply that resource finalization committed.
    pub completed_at_ms: Option<i64>,
}

#[cfg(test)]
mod tests;
