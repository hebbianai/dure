use super::{
    adoption, probe_local_session, product_catalog, project_known_healthy_session, HmuxManager,
    LocalSessionObserver, ObserverAttachOptions, ProviderConversationIdentityDescriptor,
    SessionClass, SessionDescriptor, SessionLifecycle, SessionProbeStatus, SessionSelector,
    SessionSummary,
};
use hmux_client::{recovery_journal::managed_create_ledger, PermissionMode, ProcessDescriptor};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    path::Path,
    sync::{Mutex, OnceLock},
};
use tauri::AppHandle;

/// What a Claude `SessionStart` says: the conversation the Claude process that
/// ran the hook runs from now on. Claude reports it when it starts or resumes
/// a conversation, and when `/clear`, `/resume` or `/branch` moves the same
/// process to another one in place.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ClaudeSessionStart {
    pub(crate) conversation_id: String,
    /// `/clear` started it. Only an interactive `/clear` reports source
    /// `clear`; a child Claude process that inherits the hook environment
    /// starts with `startup`.
    pub(crate) cleared: bool,
    /// The Claude process that ran the hook, when the hook names it.
    pub(crate) reporting_process: Option<u32>,
}

/// Conversations Claude moved a pane's own process to in place, by the exact
/// Host generation that reported them. `/clear`, `/resume` and `/branch`
/// write no forward link from the old transcript, so this provider-announced
/// successor is the only evidence that the same native process moved to the
/// new conversation. The report naming it can arrive before the new
/// transcript exists, so the successor is held until a report carries its
/// conversation identity.
fn announced_successors() -> &'static Mutex<HashMap<String, String>> {
    static SUCCESSORS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    SUCCESSORS.get_or_init(|| Mutex::new(HashMap::new()))
}

const MAX_ANNOUNCED_SUCCESSORS: usize = 256;

fn announced_successor_key(fence: &super::ReportedSessionFence) -> String {
    [
        fence.session_id.as_str(),
        fence.workspace_id.as_str(),
        fence.host_instance_id.as_str(),
        fence.terminal_epoch.as_str(),
    ]
    .join("\n")
}

fn record_announced_successor(fence: &super::ReportedSessionFence, conversation_id: String) {
    let Ok(mut successors) = announced_successors().lock() else {
        return;
    };
    if successors.len() >= MAX_ANNOUNCED_SUCCESSORS {
        successors.clear();
    }
    successors.insert(announced_successor_key(fence), conversation_id);
}

fn is_announced_successor(fence: &super::ReportedSessionFence, conversation_id: &str) -> bool {
    announced_successors().lock().is_ok_and(|successors| {
        successors
            .get(&announced_successor_key(fence))
            .is_some_and(|successor| successor == conversation_id)
    })
}

/// Whether a `SessionStart` names the pane's next conversation. Its own
/// provider process does, whatever moved it there. A Claude process the
/// provider did not start in place, such as a background session copied with
/// `/fork`, inherits the pane's fence and hook settings and reports its own
/// `resume` or `fork`, so the source alone proves nothing, except `clear`.
fn announces_successor(
    start: &ClaudeSessionStart,
    descriptor: Option<&SessionDescriptor>,
    provider_generation_is_live: impl FnOnce(&ProcessDescriptor) -> bool,
) -> bool {
    start.cleared
        || descriptor
            .zip(start.reporting_process)
            .is_some_and(|(descriptor, process)| {
                descriptor.provider_id == "claude"
                    && descriptor.names_live_provider_process(process, provider_generation_is_live)
            })
}

/// The exact Host generation a report is fenced to, from the local catalog.
fn fenced_descriptor(fence: &super::ReportedSessionFence) -> Option<SessionDescriptor> {
    let expected = fence.clone().into_session_fence().ok()?;
    let descriptor = product_catalog()
        .ok()?
        .find(&SessionSelector::new(
            &fence.session_id,
            Some(fence.workspace_id.clone()),
        ))
        .ok()?;
    descriptor.matches_fence(&expected).then_some(descriptor)
}

#[cfg(unix)]
fn provider_generation_is_live(process: &ProcessDescriptor) -> bool {
    hmux_client::probe_local_process_generation(process)
        .is_ok_and(|status| status == hmux_client::LocalProcessGenerationStatus::Live)
}

#[cfg(not(unix))]
fn provider_generation_is_live(_process: &ProcessDescriptor) -> bool {
    false
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedConversationIdentity {
    pub session_id: String,
    pub workspace_id: String,
    pub provider_id: String,
    pub conversation_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExistingManagedWriterRequest {
    pub session_id: String,
    pub workspace_id: String,
    pub provider_id: String,
    pub conversation_id: String,
    pub cwd: String,
    pub permission_mode: PermissionMode,
    pub credential_id: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExistingManagedWriterInspection {
    pub session: SessionSummary,
    pub idempotency_key: String,
    pub conversation_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credential_id: Option<String>,
    pub permission_mode: PermissionMode,
}

impl HmuxManager {
    /// Claude may rotate its transcript ID without replacing the native
    /// process, by continuing a transcript or by moving to another
    /// conversation in place (`/clear`, `/resume`, `/branch`). Verify its
    /// forward link, or the successor its own process announced for this
    /// exact Host generation, against the live Host identity before proposing
    /// an atomic, causally ordered continuation to that same Host.
    pub(crate) fn report_claude_agent_state<R: tauri::Runtime>(
        &self,
        app: &AppHandle<R>,
        mut request: super::AgentStateReportRequest,
        transcript: Option<&Path>,
        session_start: Option<ClaudeSessionStart>,
    ) -> Result<super::AgentStateReportReceiptSummary, super::AgentStateReportFailure> {
        if let (Some(start), Some(fence)) = (session_start, request.expected_session_fence.as_ref())
        {
            let descriptor = start
                .reporting_process
                .and_then(|_| fenced_descriptor(fence));
            if announces_successor(&start, descriptor.as_ref(), provider_generation_is_live) {
                record_announced_successor(fence, start.conversation_id);
            }
        }
        if let (Some(transcript), Some(identity), Some(expected)) = (
            transcript,
            request.conversation_identity.as_mut(),
            request.expected_session_fence.clone(),
        ) {
            if identity.provider_id == "claude" && request.causality.is_some() {
                let expected = expected
                    .into_session_fence()
                    .map_err(super::report_request_failure)?;
                let catalog = product_catalog().map_err(super::report_client_failure)?;
                let descriptor = catalog
                    .find(&SessionSelector::new(
                        &request.session_id,
                        request.workspace_id.clone(),
                    ))
                    .map_err(super::report_client_failure)?;
                let observed = hmux_client::inspect_local_session(&catalog, descriptor);
                if observed.descriptor.matches_fence(&expected) {
                    if let Some(current) =
                        observed.provider_conversation_identity.filter(|current| {
                            current.provider_id == "claude"
                                && current.conversation_id != identity.conversation_id
                        })
                    {
                        let announced =
                            request
                                .expected_session_fence
                                .as_ref()
                                .is_some_and(|fence| {
                                    is_announced_successor(fence, &identity.conversation_id)
                                });
                        if announced
                            || dure_provider_adapter::claude_continuation::claude_transcript_continues(
                                transcript,
                                &current.conversation_id,
                                &identity.conversation_id,
                            )
                        {
                            identity.previous_conversation_id = Some(current.conversation_id);
                        }
                    }
                }
            }
        }
        self.report_agent_state(app, request)
    }

    pub fn inspect_existing_managed_writer<R: tauri::Runtime>(
        &self,
        app: &AppHandle<R>,
        request: ExistingManagedWriterRequest,
    ) -> Result<ExistingManagedWriterInspection, String> {
        super::validate_identifier("session id", &request.session_id)?;
        super::validate_identifier("workspace id", &request.workspace_id)?;
        super::validate_identifier("provider id", &request.provider_id)?;
        super::validate_identifier("conversation id", &request.conversation_id)?;
        let expected_cwd = fs::canonicalize(&request.cwd).map_err(|_| {
            "existing_managed_writer_cwd_unavailable: provider cwd is missing".to_string()
        })?;
        let catalog = product_catalog().map_err(|error| error.to_string())?;
        let selector = SessionSelector::new(
            request.session_id.clone(),
            Some(request.workspace_id.clone()),
        );
        let descriptor = catalog.find(&selector).map_err(|error| error.to_string())?;
        if descriptor.session_class != SessionClass::Managed
            || descriptor.session_id != request.session_id
            || descriptor.workspace_id != request.workspace_id
            || descriptor.provider_id != request.provider_id
            || descriptor.lifecycle != SessionLifecycle::Ready
            || probe_local_session(&catalog, &selector) != SessionProbeStatus::Healthy
        {
            return Err(
                "existing_managed_writer_unavailable: exact managed Host is not healthy"
                    .to_string(),
            );
        }
        let receipt = managed_create_ledger::completed_create_receipt(
            catalog.discovery_root(),
            &request.workspace_id,
            &request.session_id,
        )?
        .ok_or_else(|| {
            "existing_managed_writer_unverified: create receipt is unavailable".to_string()
        })?;
        let fence = receipt.generation_fence().ok_or_else(|| {
            "existing_managed_writer_unverified: create generation fence is unavailable"
                .to_string()
        })?;
        if receipt.provider_id() != request.provider_id
            || receipt.permission_mode() != request.permission_mode
            || receipt.discovery_root() != catalog.discovery_root()
            || !fence.matches_generation(
                &descriptor.runner_principal,
                &descriptor.runner_instance,
                &descriptor.channel_epoch,
                &descriptor.host_instance_id,
                &descriptor.terminal_epoch,
            )
        {
            return Err(
                "existing_managed_writer_mismatch: create receipt changed generation".to_string(),
            );
        }
        let recipe = managed_create_ledger::managed_rehost_recipe(
            catalog.discovery_root(),
            &request.workspace_id,
            &request.session_id,
        )?;
        let credential_id = match recipe {
            Some(recipe) => {
                let credential_id = recipe.rehost().launch_reference().map(str::to_string);
                if recipe.provider_id() != request.provider_id
                    || recipe.permission_mode() != request.permission_mode
                    || recipe.provider_cwd() != expected_cwd
                    || credential_id != request.credential_id
                {
                    return Err(
                        "existing_managed_writer_mismatch: launch identity changed".to_string(),
                    );
                }
                credential_id
            }
            None if request.credential_id.is_none() => None,
            None => {
                return Err(
                    "existing_managed_writer_unverified: credential launch identity is unavailable"
                        .to_string(),
                );
            }
        };
        let identity = self.inspect_managed_conversation_identity(
            app,
            request.session_id.clone(),
            request.workspace_id.clone(),
            request.provider_id.clone(),
            request.cwd,
        )?;
        if identity.conversation_id != request.conversation_id {
            return Err(
                "existing_managed_writer_mismatch: conversation identity changed".to_string(),
            );
        }
        let current = catalog.find(&selector).map_err(|error| error.to_string())?;
        if !descriptor.same_generation(&current)
            || probe_local_session(&catalog, &selector) != SessionProbeStatus::Healthy
        {
            return Err(
                "existing_managed_writer_mismatch: managed Host generation changed".to_string(),
            );
        }
        Ok(ExistingManagedWriterInspection {
            session: project_known_healthy_session(current),
            idempotency_key: receipt.idempotency_key().to_string(),
            conversation_id: identity.conversation_id,
            credential_id,
            permission_mode: receipt.permission_mode(),
        })
    }

    pub fn inspect_managed_conversation_identity<R: tauri::Runtime>(
        &self,
        app: &AppHandle<R>,
        session_id: String,
        workspace_id: String,
        provider_id: String,
        cwd: String,
    ) -> Result<ManagedConversationIdentity, String> {
        super::validate_identifier("session id", &session_id)?;
        super::validate_identifier("workspace id", &workspace_id)?;
        super::validate_identifier("provider id", &provider_id)?;
        let catalog = product_catalog().map_err(|error| error.to_string())?;
        let selector = SessionSelector::new(session_id.clone(), Some(workspace_id.clone()));
        let descriptor = catalog.find(&selector).map_err(|error| error.to_string())?;
        if descriptor.session_class != SessionClass::Managed
            || descriptor.session_id != session_id
            || descriptor.workspace_id != workspace_id
            || descriptor.provider_id != provider_id
            || descriptor.lifecycle != SessionLifecycle::Ready
        {
            return Err(
                "conversation_identity_source_mismatch: managed session identity changed"
                    .to_string(),
            );
        }
        if probe_local_session(&catalog, &selector) != SessionProbeStatus::Healthy {
            return Err(
                "conversation_identity_source_unavailable: managed Host is not healthy".to_string(),
            );
        }
        if !matches!(provider_id.as_str(), "codex" | "claude") {
            return Err(
                "conversation_identity_adapter_unsupported: provider has no reviewed live identity adapter"
                    .to_string(),
            );
        }
        let observer = LocalSessionObserver::connect(
            &catalog,
            &selector,
            ObserverAttachOptions::default(),
        )
        .map_err(|error| {
            format!(
                "conversation_identity_source_unavailable: attach managed Host failed: {error}"
            )
        })?;
        let projected_conversation_id = {
            let attachment = observer.attachment();
            if !descriptor.same_generation(&attachment.session) {
                Err(
                    "conversation_identity_source_mismatch: managed Host generation changed"
                        .to_string(),
                )
            } else {
                attachment
                    .initial_snapshot
                    .provider_conversation_identity
                    .as_deref()
                    .map(|identity| {
                        validate_projected_conversation_identity(
                            &descriptor,
                            &provider_id,
                            identity,
                        )
                    })
                    .transpose()
            }
        };
        observer.detach().map_err(|error| {
            format!(
                "conversation_identity_source_unavailable: detach managed Host observer failed: {error}"
            )
        })?;
        let projected_conversation_id = projected_conversation_id?;
        let inspected_from_provider = projected_conversation_id.is_none();
        let conversation_id = match projected_conversation_id {
            Some(conversation_id) => conversation_id,
            None => adoption::inspect_managed_provider(
                descriptor.provider_process.process_id,
                &provider_id,
                Path::new(&cwd),
            )?,
        };
        let current = catalog.find(&selector).map_err(|error| error.to_string())?;
        if !descriptor.same_generation(&current) {
            return Err(
                "conversation_identity_source_mismatch: managed Host generation changed"
                    .to_string(),
            );
        }
        if inspected_from_provider {
            self.report_managed_provider_conversation_identity(
                app,
                &descriptor,
                &conversation_id,
            )?;
        }
        crate::session_credentials::observe_managed_conversation(&descriptor, &conversation_id)?;
        Ok(ManagedConversationIdentity {
            session_id,
            workspace_id,
            provider_id,
            conversation_id,
        })
    }
}

fn validate_projected_conversation_identity(
    descriptor: &SessionDescriptor,
    provider_id: &str,
    identity: &ProviderConversationIdentityDescriptor,
) -> Result<String, String> {
    if identity.session_id != descriptor.session_id
        || identity.workspace_id != descriptor.workspace_id
        || identity.runner_principal != descriptor.runner_principal
        || identity.runner_instance != descriptor.runner_instance
        || identity.channel_epoch != descriptor.channel_epoch
        || identity.host_instance_id != descriptor.host_instance_id
        || identity.terminal_epoch != descriptor.terminal_epoch
        || identity.provider_id != provider_id
        || identity.conversation_id.is_empty()
    {
        return Err(
            "conversation_identity_source_mismatch: Host projection does not match the current generation"
                .to_string(),
        );
    }
    Ok(identity.conversation_id.clone())
}

#[cfg(test)]
mod tests {
    use super::{
        announces_successor, validate_projected_conversation_identity, ClaudeSessionStart,
    };
    use hmux_client::{
        EndpointDescriptor, EndpointKind, ProcessDescriptor, ProtocolVersion,
        ProviderConversationIdentityDescriptor, ProviderConversationIdentitySource, SessionClass,
        SessionDescriptor, SessionLifecycle, VersionRange,
    };

    fn descriptor() -> SessionDescriptor {
        SessionDescriptor {
            schema_version: 1,
            session_id: "session-1".into(),
            session_name: None,
            workspace_id: "workspace-1".into(),
            session_class: SessionClass::Managed,
            lifecycle: SessionLifecycle::Ready,
            provider_id: "codex".into(),
            runtime_host: None,
            worktree_alias: None,
            branch: None,
            launch_program: Some("codex".into()),
            runner_principal: "principal-1".into(),
            runner_instance: "runner-1".into(),
            channel_epoch: "7".into(),
            host_instance_id: "host-1".into(),
            terminal_epoch: "terminal-1".into(),
            output_seq: "11".into(),
            host_build_version: "build-1".into(),
            supported_protocol: VersionRange {
                minimum: ProtocolVersion { major: 1, minor: 0 },
                maximum: ProtocolVersion { major: 1, minor: 0 },
            },
            capabilities: Vec::new(),
            retirement_policy: None,
            host_process: ProcessDescriptor {
                process_id: 10,
                start_marker: "host-start".into(),
            },
            provider_process: ProcessDescriptor {
                process_id: 11,
                start_marker: "provider-start".into(),
            },
            endpoint: EndpointDescriptor {
                kind: EndpointKind::UnixSocket,
                address: "/tmp/hmux-conversation-test.sock".into(),
            },
            created_unix_ms: "1".into(),
            lifecycle_changed_unix_ms: "2".into(),
            exit: None,
            failure: None,
        }
    }

    fn projection() -> ProviderConversationIdentityDescriptor {
        ProviderConversationIdentityDescriptor {
            session_id: "session-1".into(),
            workspace_id: "workspace-1".into(),
            runner_principal: "principal-1".into(),
            runner_instance: "runner-1".into(),
            channel_epoch: "7".into(),
            host_instance_id: "host-1".into(),
            terminal_epoch: "terminal-1".into(),
            revision: "3".into(),
            observed_through_output_seq: "11".into(),
            provider_id: "codex".into(),
            conversation_id: "019fa780-c26f-7a72-9544-cf09f3e89e35".into(),
            source: ProviderConversationIdentitySource::ProviderEvent,
        }
    }

    fn start(cleared: bool, reporting_process: Option<u32>) -> ClaudeSessionStart {
        ClaudeSessionStart {
            conversation_id: "fixture-next".into(),
            cleared,
            reporting_process,
        }
    }

    /// Claude Code 2.1.331 reports `/resume <id>` and `/branch` from the
    /// pane's own process (SessionStart `resume` and `fork`), and `/fork`
    /// from a background session's process that inherits the pane's fence
    /// (SessionStart `fork`). Only the pane's own process moves the pane.
    #[test]
    fn only_the_hosts_own_live_provider_process_names_the_next_conversation() {
        let mut claude = descriptor();
        claude.provider_id = "claude".into();
        let provider = claude.provider_process.process_id;
        let live = |_: &hmux_client::ProcessDescriptor| true;
        assert!(announces_successor(
            &start(false, Some(provider)),
            Some(&claude),
            live
        ));
        // Another Claude process with the pane's fence, such as a background
        // session copied with `/fork`.
        assert!(!announces_successor(
            &start(false, Some(provider + 1)),
            Some(&claude),
            live
        ));
        // The exact provider generation is gone, so its process id may name
        // a later process.
        let mut probed = None;
        assert!(!announces_successor(
            &start(false, Some(provider)),
            Some(&claude),
            |process| {
                probed = Some(process.clone());
                false
            },
        ));
        assert_eq!(probed.as_ref(), Some(&claude.provider_process));
        // No process named, no exact Host generation, or another provider.
        assert!(!announces_successor(
            &start(false, None),
            Some(&claude),
            live
        ));
        assert!(!announces_successor(
            &start(false, Some(provider)),
            None,
            live
        ));
        assert!(!announces_successor(
            &start(false, Some(provider)),
            Some(&descriptor()),
            live
        ));
    }

    #[test]
    fn an_interactive_clear_keeps_naming_its_conversation_without_a_process() {
        let mut claude = descriptor();
        claude.provider_id = "claude".into();
        let gone = |_: &hmux_client::ProcessDescriptor| false;
        assert!(announces_successor(&start(true, None), None, gone));
        assert!(announces_successor(
            &start(true, Some(1_999)),
            Some(&claude),
            gone
        ));
    }

    #[test]
    fn accepts_the_exact_host_projected_conversation_identity() {
        assert_eq!(
            validate_projected_conversation_identity(&descriptor(), "codex", &projection())
                .unwrap(),
            "019fa780-c26f-7a72-9544-cf09f3e89e35"
        );
    }

    #[test]
    fn rejects_a_projection_from_another_host_generation() {
        let mut mismatched = projection();
        mismatched.host_instance_id = "host-successor".into();
        assert!(
            validate_projected_conversation_identity(&descriptor(), "codex", &mismatched)
                .is_err()
        );
    }
}
