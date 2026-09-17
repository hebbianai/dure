use crate::recovery_journal::{ManagedRehostResolutionLookup, resolve_managed_rehost_current};
use crate::{ClientError, LocalSession, LocalSessionCatalog, SessionDescriptor, SessionSelector};
use hmux_runtime_contract::{
    MANAGED_REHOST_RESOLUTION_SCHEMA, MANAGED_REHOST_RESOLUTION_SCHEMA_VERSION,
    ManagedRehostGeneration, ManagedRehostResolution,
};
use hmux_session_protocol::SessionFence;
use serde::Serialize;

/** Stable machine-readable projection shared by CLI and application adapters. */
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(untagged)]
pub enum ManagedRehostResolutionResponse {
    Resolved(Box<ManagedRehostResolution>),
    Lookup(ManagedRehostResolutionLookupResponse),
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedRehostResolutionLookupResponse {
    schema: &'static str,
    schema_version: u16,
    state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    operation_id: Option<String>,
    source: ManagedRehostResolutionSourceResponse,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct ManagedRehostResolutionSourceResponse {
    session_id: String,
    workspace_id: String,
}

impl ManagedRehostResolutionResponse {
    #[must_use]
    pub fn from_lookup(
        lookup: ManagedRehostResolutionLookup,
        session_id: &str,
        workspace_id: &str,
    ) -> Self {
        match lookup {
            ManagedRehostResolutionLookup::Resolved(resolution) => Self::Resolved(resolution),
            ManagedRehostResolutionLookup::NotFound => {
                Self::lookup("not_found", None, session_id, workspace_id)
            }
            ManagedRehostResolutionLookup::RetryRequired { operation_id } => Self::lookup(
                "retry_required",
                Some(operation_id),
                session_id,
                workspace_id,
            ),
        }
    }

    fn lookup(
        state: &'static str,
        operation_id: Option<String>,
        session_id: &str,
        workspace_id: &str,
    ) -> Self {
        Self::Lookup(ManagedRehostResolutionLookupResponse {
            schema: MANAGED_REHOST_RESOLUTION_SCHEMA,
            schema_version: MANAGED_REHOST_RESOLUTION_SCHEMA_VERSION,
            state,
            code: operation_id
                .as_ref()
                .map(|_| "hmux_managed_rehost_retry_required"),
            operation_id,
            source: ManagedRehostResolutionSourceResponse {
                session_id: session_id.to_string(),
                workspace_id: workspace_id.to_string(),
            },
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ManagedSessionTarget {
    selector: SessionSelector,
    source_generation: Option<ManagedRehostGeneration>,
    expected_generation: Option<ManagedRehostGeneration>,
}

impl ManagedSessionTarget {
    fn original(selector: &SessionSelector) -> Self {
        Self {
            selector: selector.clone(),
            source_generation: None,
            expected_generation: None,
        }
    }

    fn resolved(
        source_generation: ManagedRehostGeneration,
        generation: ManagedRehostGeneration,
    ) -> Self {
        Self {
            selector: SessionSelector::new(
                generation.session_id(),
                Some(generation.workspace_id().to_string()),
            ),
            source_generation: Some(source_generation),
            expected_generation: Some(generation),
        }
    }

    fn verify(&self, descriptor: &SessionDescriptor) -> Result<(), ClientError> {
        let Some(expected) = self.expected_generation.as_ref() else {
            return Ok(());
        };
        if descriptor.workspace_id == expected.workspace_id()
            && descriptor.session_id == expected.session_id()
            && descriptor.runner_principal == expected.runner_principal()
            && descriptor.runner_instance == expected.runner_instance()
            && descriptor.channel_epoch == expected.channel_epoch()
            && descriptor.host_instance_id == expected.host_instance_id()
            && descriptor.terminal_epoch == expected.terminal_epoch()
        {
            return Ok(());
        }
        Err(ClientError::transport(
            "hmux_managed_rehost_generation_mismatch",
            "durable managed successor no longer matches its discovered Host generation",
        ))
    }

    fn authorizes_mutation(&self, descriptor: &SessionDescriptor, expected: &SessionFence) -> bool {
        descriptor.matches_fence(expected)
            || self
                .source_generation
                .as_ref()
                .is_some_and(|source| generation_matches_fence(source, expected))
    }
}

fn generation_matches_fence(generation: &ManagedRehostGeneration, fence: &SessionFence) -> bool {
    generation.workspace_id() == fence.workspace_id
        && generation.session_id() == fence.session_id
        && generation.runner_principal() == fence.runner_principal
        && generation.runner_instance() == fence.runner_instance
        && generation.channel_epoch() == fence.channel_epoch.to_string()
        && generation.host_instance_id() == fence.host_instance_id
        && generation.terminal_epoch() == fence.terminal_epoch
}

pub(crate) fn select_managed_session_target(
    source: &SessionSelector,
    lookup: ManagedRehostResolutionLookup,
) -> Result<ManagedSessionTarget, String> {
    match lookup {
        ManagedRehostResolutionLookup::RetryRequired { operation_id } => Err(format!(
            "hmux_managed_rehost_retry_required: operation {operation_id} is not resolved"
        )),
        ManagedRehostResolutionLookup::NotFound => Ok(ManagedSessionTarget::original(source)),
        ManagedRehostResolutionLookup::Resolved(resolution) => Ok(ManagedSessionTarget::resolved(
            resolution.source_generation().clone(),
            resolution.current_generation().clone(),
        )),
    }
}

fn merge_managed_rehost_lookup(
    current: ManagedRehostResolutionLookup,
    next: ManagedRehostResolutionLookup,
) -> Result<ManagedRehostResolutionLookup, String> {
    use ManagedRehostResolutionLookup::{NotFound, Resolved, RetryRequired};

    match (current, next) {
        (NotFound, next) | (next, NotFound) => Ok(next),
        (
            RetryRequired {
                operation_id: left,
            },
            RetryRequired {
                operation_id: right,
            },
        ) if left == right => Ok(RetryRequired { operation_id: left }),
        (Resolved(mut left), Resolved(right)) => {
            left.merge_compatible(&right).map_err(|_| {
                "hmux_managed_rehost_resolution_conflict: discovery roots disagree on the current managed generation"
                    .to_string()
            })?;
            Ok(Resolved(left))
        }
        _ => Err(
            "hmux_managed_rehost_resolution_conflict: discovery roots disagree on the current managed generation"
                .to_string(),
        ),
    }
}

fn resolve_managed_rehost_across_roots(
    catalog: &LocalSessionCatalog,
    workspace_id: &str,
    session_id: &str,
) -> Result<ManagedRehostResolutionLookup, String> {
    let mut roots = std::iter::once(catalog.discovery_root()).chain(
        catalog
            .read_only_discovery_roots()
            .iter()
            .map(|path| path.as_path()),
    );
    roots.try_fold(ManagedRehostResolutionLookup::NotFound, |current, root| {
        let next = resolve_managed_rehost_current(root, workspace_id, session_id)?;
        merge_managed_rehost_lookup(current, next)
    })
}

impl LocalSessionCatalog {
    /// Resolve a stable managed source through every configured discovery root.
    /// This is the read-only authority shared by attach and presentation repair.
    pub fn resolve_current_managed_rehost(
        &self,
        source: &SessionSelector,
    ) -> Result<ManagedRehostResolutionLookup, ClientError> {
        let workspace_id = source.workspace_id.as_deref().ok_or_else(|| {
            ClientError::transport(
                "hmux_managed_rehost_resolution_failed",
                "managed rehost resolution requires an exact workspace identity",
            )
        })?;
        resolve_managed_rehost_across_roots(self, workspace_id, &source.session_id).map_err(
            |message| ClientError::transport("hmux_managed_rehost_resolution_failed", message),
        )
    }

    /// Open the current exact generation addressed by a durable managed source.
    ///
    /// A pane may retain its original logical source across any number of
    /// rehosts. Resolution is one bounded journal/index read; a pending edge
    /// fails closed, and the discovered manifest must match the complete
    /// durable successor generation before attach authority is exposed.
    pub fn open_current_managed(
        &self,
        source: &SessionSelector,
    ) -> Result<LocalSession, ClientError> {
        if source.workspace_id.is_none() {
            return self.open(source);
        }
        let lookup = self.resolve_current_managed_rehost(source)?;
        let target = select_managed_session_target(source, lookup).map_err(|message| {
            ClientError::transport("hmux_managed_rehost_retry_required", message)
        })?;
        let session = self.open(&target.selector)?;
        target.verify(session.descriptor())?;
        Ok(session)
    }

    /// Open the current generation while accepting only a fence that names
    /// either that generation or the exact retired source of its durable
    /// rehost chain. This keeps a stale WebView projection from becoming
    /// mutation authority while allowing a stable logical session identity to
    /// survive rehost.
    pub fn open_current_managed_for_mutation(
        &self,
        source: &SessionSelector,
        expected: &SessionFence,
    ) -> Result<LocalSession, ClientError> {
        if source.workspace_id.is_none() {
            return Err(ClientError::transport(
                "hmux_expected_generation_invalid",
                "managed mutation requires an exact workspace identity",
            ));
        }
        let lookup = self.resolve_current_managed_rehost(source)?;
        let target = select_managed_session_target(source, lookup).map_err(|message| {
            ClientError::transport("hmux_managed_rehost_retry_required", message)
        })?;
        let session = self.open(&target.selector)?;
        target.verify(session.descriptor())?;
        if !target.authorizes_mutation(session.descriptor(), expected) {
            return Err(ClientError::transport(
                "hmux_expected_generation_mismatch",
                "expected fence names neither the current generation nor its exact durable rehost source",
            ));
        }
        Ok(session)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hmux_runtime_contract::{
        ManagedCreateGenerationFence, ManagedCreateOutcome, ManagedCreateReceipt,
        ManagedRehostLaunchIdentity, ManagedRehostResolution, ManagedStopOutcome,
        ManagedStopReceipt, ManagedStopRequest, PermissionMode,
    };
    use std::path::Path;

    fn resolved_successor() -> ManagedRehostResolutionLookup {
        ManagedRehostResolutionLookup::Resolved(Box::new(successor_resolution(None)))
    }

    fn successor_resolution(
        launch_identity: Option<ManagedRehostLaunchIdentity>,
    ) -> ManagedRehostResolution {
        let source = ManagedStopReceipt::from_request(
            &ManagedStopRequest::new("stop-source", "source-session", "workspace-1")
                .unwrap()
                .with_expected_fence(
                    "source-principal",
                    "source-runner",
                    7,
                    "source-host",
                    "source-terminal",
                )
                .unwrap(),
            ManagedStopOutcome::Stopped,
            "source stopped",
        )
        .unwrap();
        let replacement = ManagedCreateReceipt::new(
            "create-successor",
            "successor-session",
            "workspace-1",
            "provider",
            PermissionMode::Default,
            Path::new("/tmp/hmux-managed-session-target"),
            ManagedCreateOutcome::Created,
        )
        .unwrap()
        .with_generation_fence(
            ManagedCreateGenerationFence::new(
                "successor-principal",
                "successor-runner",
                8,
                "successor-host",
                "successor-terminal",
            )
            .unwrap(),
        )
        .unwrap();
        ManagedRehostResolution::from_receipts_with_launch_identity(
            "rehost-source",
            &source,
            &replacement,
            launch_identity,
        )
        .unwrap()
    }

    #[test]
    fn resolution_response_has_one_stable_lookup_schema() {
        let not_found = serde_json::to_value(ManagedRehostResolutionResponse::from_lookup(
            ManagedRehostResolutionLookup::NotFound,
            "source-session",
            "workspace-1",
        ))
        .unwrap();
        assert_eq!(not_found["schema"], MANAGED_REHOST_RESOLUTION_SCHEMA);
        assert_eq!(
            not_found["schemaVersion"],
            MANAGED_REHOST_RESOLUTION_SCHEMA_VERSION
        );
        assert_eq!(not_found["state"], "not_found");
        assert_eq!(not_found["source"]["sessionId"], "source-session");
        assert!(not_found.get("operationId").is_none());

        let retry = serde_json::to_value(ManagedRehostResolutionResponse::from_lookup(
            ManagedRehostResolutionLookup::RetryRequired {
                operation_id: "operation-1".to_string(),
            },
            "source-session",
            "workspace-1",
        ))
        .unwrap();
        assert_eq!(retry["state"], "retry_required");
        assert_eq!(retry["code"], "hmux_managed_rehost_retry_required");
        assert_eq!(retry["operationId"], "operation-1");
    }

    #[test]
    fn structured_attach_selects_the_durable_current_generation() {
        let source = SessionSelector::new("source-session", Some("workspace-1".into()));

        let target = select_managed_session_target(&source, resolved_successor()).unwrap();

        assert_eq!(target.selector.session_id, "successor-session");
        assert_eq!(target.selector.workspace_id.as_deref(), Some("workspace-1"));
        let generation = target
            .expected_generation
            .expect("a resolved successor must retain its exact generation fence");
        assert_eq!(generation.host_instance_id(), "successor-host");
        assert_eq!(generation.terminal_epoch(), "successor-terminal");
    }

    #[test]
    fn pending_rehost_never_falls_back_to_the_retired_source() {
        let source = SessionSelector::new("source-session", Some("workspace-1".into()));

        let error = select_managed_session_target(
            &source,
            ManagedRehostResolutionLookup::RetryRequired {
                operation_id: "rehost-pending".into(),
            },
        )
        .unwrap_err();

        assert!(error.contains("rehost-pending"));
    }

    #[test]
    fn compatibility_root_resolution_is_not_shadowed_by_an_empty_canonical_root() {
        let merged = merge_managed_rehost_lookup(
            ManagedRehostResolutionLookup::NotFound,
            resolved_successor(),
        )
        .unwrap();
        let source = SessionSelector::new("source-session", Some("workspace-1".into()));

        let target = select_managed_session_target(&source, merged).unwrap();

        assert_eq!(target.selector.session_id, "successor-session");
        assert_eq!(target.selector.workspace_id.as_deref(), Some("workspace-1"));
    }

    #[test]
    fn compatibility_roots_enrich_an_exact_legacy_lineage_without_changing_it() {
        let identity = ManagedRehostLaunchIdentity::new(
            Some("credential+profile".into()),
            Some("conversation-current".into()),
        )
        .unwrap();
        let merged = merge_managed_rehost_lookup(
            ManagedRehostResolutionLookup::Resolved(Box::new(successor_resolution(None))),
            ManagedRehostResolutionLookup::Resolved(Box::new(successor_resolution(Some(
                identity.clone(),
            )))),
        )
        .unwrap();
        let ManagedRehostResolutionLookup::Resolved(resolution) = merged else {
            panic!("two exact roots must retain one resolved lineage")
        };

        assert_eq!(resolution.launch_identity(), Some(&identity));
    }

    #[test]
    fn compatibility_roots_reject_two_known_launch_identities() {
        let exact = |reference: &str| {
            ManagedRehostResolutionLookup::Resolved(Box::new(successor_resolution(Some(
                ManagedRehostLaunchIdentity::new(Some(reference.into()), None).unwrap(),
            ))))
        };

        let error = merge_managed_rehost_lookup(exact("credential+one"), exact("credential+two"))
            .unwrap_err();

        assert!(error.contains("discovery roots disagree"), "{error}");
    }

    #[test]
    fn durable_source_fence_authorizes_only_its_exact_successor() {
        let source = SessionSelector::new("source-session", Some("workspace-1".into()));
        let target = select_managed_session_target(&source, resolved_successor()).unwrap();
        let expected = SessionFence {
            workspace_id: "workspace-1".into(),
            session_id: "source-session".into(),
            runner_principal: "source-principal".into(),
            runner_instance: "source-runner".into(),
            channel_epoch: 7,
            host_instance_id: "source-host".into(),
            terminal_epoch: "source-terminal".into(),
        };

        assert!(
            target
                .source_generation
                .as_ref()
                .is_some_and(|generation| { generation_matches_fence(generation, &expected) })
        );
        assert!(
            !target.source_generation.as_ref().is_some_and(|generation| {
                generation_matches_fence(
                    generation,
                    &SessionFence {
                        terminal_epoch: "unrelated-terminal".into(),
                        ..expected
                    },
                )
            })
        );
    }
}
