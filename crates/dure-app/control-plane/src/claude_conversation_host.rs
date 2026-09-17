use std::collections::BTreeMap;
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, Weak};

use dure_app::{
    AgentInteractionBindingV1, AgentInteractionSessionIdV1, AgentProviderRuntimeFenceV1,
    AgentSpawnEffortSelectionV1, AgentSpawnModelSelectionV1, AgentTimelineStore,
    ProviderPermissionModeV1,
};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use tokio::sync::{Mutex as AsyncMutex, RwLock, broadcast};

use crate::agent_conversation::{AgentConversationService, AgentProviderCommands};
use crate::agent_conversation_api::{
    AgentConversationApiErrorV1, AgentConversationRuntimeRegistry,
};
use crate::claude_sdk_host_client::{
    AttachedClaudeDch1Client, ClaudeDch1Client, ClaudeDch1HostIdentity,
    ClaudeDch1ProviderRetirementAuthority, ClaudeDch1ProviderRetirementPhase,
    ClaudeDch1QueryIdentity,
};
use crate::claude_sdk_host_supervisor::{
    ClaudeSdkHostSupervisor, ClaudeSdkHostSupervisorConfiguration,
};
use crate::claude_timeline_bridge::{ClaudeTimelineBridge, ClaudeTimelineBridgeError};

#[derive(Clone)]
pub struct ClaudeConversationProcessBindingV1 {
    pub relay_capability: String,
    pub relay_endpoint: PathBuf,
}

impl fmt::Debug for ClaudeConversationProcessBindingV1 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ClaudeConversationProcessBindingV1")
            .field("relay_capability", &"<redacted>")
            .field("relay_endpoint", &self.relay_endpoint)
            .finish()
    }
}

#[derive(Clone)]
pub struct ClaudeConversationAttachmentV1 {
    pub binding: AgentInteractionBindingV1,
    pub cwd: PathBuf,
    pub environment: BTreeMap<String, String>,
    pub permission_mode: ProviderPermissionModeV1,
    pub model: Option<AgentSpawnModelSelectionV1>,
    pub effort: Option<AgentSpawnEffortSelectionV1>,
    pub process: Option<ClaudeConversationProcessBindingV1>,
    pub relay_id: String,
    pub replacement_authority: Option<ClaudeDch1ProviderRetirementAuthority>,
}

impl fmt::Debug for ClaudeConversationAttachmentV1 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ClaudeConversationAttachmentV1")
            .field("binding", &self.binding)
            .field("cwd", &self.cwd)
            .field(
                "environment_keys",
                &self.environment.keys().collect::<Vec<_>>(),
            )
            .field("permission_mode", &self.permission_mode)
            .field("model", &self.model)
            .field("effort", &self.effort)
            .field("process", &self.process)
            .field("relay_id", &self.relay_id)
            .field("replacement_authority", &self.replacement_authority)
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClaudeConversationAttachmentReceiptV1 {
    pub binding: AgentInteractionBindingV1,
    pub host_process_id: u32,
    pub host_identity: ClaudeDch1HostIdentity,
    pub identity: ClaudeDch1QueryIdentity,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClaudeQueryBindReceiptV1 {
    host_identity: ClaudeDch1HostIdentity,
    identity: ClaudeDch1QueryIdentity,
    state: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
enum ClaudeQueryRetirementOutcomeV1 {
    Retired,
    AlreadyRetired,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
enum ClaudeQueryRetirementRecoveryOutcomeV1 {
    Recovered,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClaudeQueryRetirementReceiptV1 {
    authority: ClaudeDch1ProviderRetirementAuthority,
    identity: ClaudeDch1QueryIdentity,
    outcome: ClaudeQueryRetirementOutcomeV1,
    replay_committed: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClaudeQueryRetirementRecoveryReceiptV1 {
    authority: ClaudeDch1ProviderRetirementAuthority,
    identity: ClaudeDch1QueryIdentity,
    outcome: ClaudeQueryRetirementRecoveryOutcomeV1,
    replay_committed: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
enum ClaudeQueryRetirementReleaseOutcomeV1 {
    Released,
    AlreadyReleased,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClaudeQueryRetirementReleaseReceiptV1 {
    authority: ClaudeDch1ProviderRetirementAuthority,
    outcome: ClaudeQueryRetirementReleaseOutcomeV1,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
enum ClaudeQueryRetirementConfirmOutcomeV1 {
    Confirmed,
    AlreadyAbsent,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClaudeQueryRetirementConfirmReceiptV1 {
    authority: ClaudeDch1ProviderRetirementAuthority,
    outcome: ClaudeQueryRetirementConfirmOutcomeV1,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
enum ClaudeQueryReplacementCommitOutcomeV1 {
    TargetBound,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClaudeQueryReplacementCommitReceiptV1 {
    authority: ClaudeDch1ProviderRetirementAuthority,
    outcome: ClaudeQueryReplacementCommitOutcomeV1,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
enum ClaudeQueryRetirementRetargetOutcomeV1 {
    Retargeted,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClaudeQueryRetirementRetargetReceiptV1 {
    authority: ClaudeDch1ProviderRetirementAuthority,
    outcome: ClaudeQueryRetirementRetargetOutcomeV1,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClaudeConversationHostErrorV1 {
    attach_effect: ClaudeConversationAttachEffectV1,
    kind: ClaudeConversationHostFailureKindV1,
    reason: String,
    /// Free-form evidence behind `reason` (the host's stderr tail, say).
    /// Recorded alongside the reason so a persisted failure says why, not just
    /// which code. Never machine-matched.
    detail: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ClaudeConversationHostFailureKindV1 {
    Other,
    SourceBusy,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ClaudeConversationAttachEffectV1 {
    NoQuery,
    QueryRetired(Box<ClaudeDch1ProviderRetirementAuthority>),
    Unknown,
}

impl ClaudeConversationHostErrorV1 {
    fn new(reason: impl Into<String>) -> Self {
        Self {
            attach_effect: ClaudeConversationAttachEffectV1::NoQuery,
            kind: ClaudeConversationHostFailureKindV1::Other,
            reason: reason.into(),
            detail: None,
        }
    }

    fn source_busy(reason: impl Into<String>) -> Self {
        Self {
            attach_effect: ClaudeConversationAttachEffectV1::NoQuery,
            kind: ClaudeConversationHostFailureKindV1::SourceBusy,
            reason: reason.into(),
            detail: None,
        }
    }

    fn attach_unknown(reason: impl Into<String>) -> Self {
        Self {
            attach_effect: ClaudeConversationAttachEffectV1::Unknown,
            kind: ClaudeConversationHostFailureKindV1::Other,
            reason: reason.into(),
            detail: None,
        }
    }

    fn attach_retired(
        reason: impl Into<String>,
        authority: ClaudeDch1ProviderRetirementAuthority,
    ) -> Self {
        Self {
            attach_effect: ClaudeConversationAttachEffectV1::QueryRetired(Box::new(authority)),
            kind: ClaudeConversationHostFailureKindV1::Other,
            reason: reason.into(),
            detail: None,
        }
    }

    /// Attaches the evidence behind an already-classified failure.
    fn with_detail(mut self, detail: Option<impl Into<String>>) -> Self {
        self.detail = detail.map(Into::into);
        self
    }

    pub fn reason(&self) -> &str {
        &self.reason
    }

    #[must_use]
    pub fn detail(&self) -> Option<&str> {
        self.detail.as_deref()
    }

    pub fn attach_effect(&self) -> &ClaudeConversationAttachEffectV1 {
        &self.attach_effect
    }

    pub fn is_source_busy(&self) -> bool {
        self.kind == ClaudeConversationHostFailureKindV1::SourceBusy
    }
}

impl fmt::Display for ClaudeConversationHostErrorV1 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "dure_claude_conversation_host_{}", self.reason)
    }
}

impl std::error::Error for ClaudeConversationHostErrorV1 {}

struct ConversationRoute<S>
where
    S: AgentTimelineStore + 'static,
{
    bridge: Arc<ClaudeTimelineBridge<S, ClaudeDch1Client>>,
    interaction_session_id: AgentInteractionSessionIdV1,
    permission_mode: ProviderPermissionModeV1,
    model: Option<AgentSpawnModelSelectionV1>,
    effort: Option<AgentSpawnEffortSelectionV1>,
    reconcile_lock: AsyncMutex<()>,
}

impl<S> ConversationRoute<S>
where
    S: AgentTimelineStore + 'static,
{
    async fn reconcile(&self) -> Result<(), ClaudeTimelineBridgeError> {
        let _guard = self.reconcile_lock.lock().await;
        self.bridge.reconcile().await
    }

    async fn ingest(
        &self,
        frame: &crate::claude_sdk_host_client::ClaudeDch1EventFrame,
    ) -> Result<(), ClaudeTimelineBridgeError> {
        let _guard = self.reconcile_lock.lock().await;
        self.bridge.ingest_pushed(frame).await.map(|_| ())
    }
}

type RouteMap<S> = BTreeMap<ClaudeDch1QueryIdentity, Arc<ConversationRoute<S>>>;

#[derive(Clone)]
struct ConnectedClaudeSdkHost {
    client: ClaudeDch1Client,
    host_identity: ClaudeDch1HostIdentity,
    process_id: u32,
}

/// One backend-owned Claude SDK host and one DCH1 connection shared by every
/// attached Claude conversation. Per-interaction bridges hold no Node process
/// or socket of their own.
pub struct ClaudeConversationHost<S>
where
    S: AgentTimelineStore + 'static,
{
    attach_lock: AsyncMutex<()>,
    client: AsyncMutex<Option<ConnectedClaudeSdkHost>>,
    client_attach_count: AtomicU32,
    client_generation: String,
    routes: Arc<RwLock<RouteMap<S>>>,
    runtime_registry: Arc<AgentConversationRuntimeRegistry>,
    service: Arc<AgentConversationService<S>>,
    supervisor: Mutex<ClaudeSdkHostSupervisor>,
}

impl<S> ClaudeConversationHost<S>
where
    S: AgentTimelineStore + 'static,
{
    pub fn new(
        configuration: ClaudeSdkHostSupervisorConfiguration,
        client_generation: impl Into<String>,
        service: Arc<AgentConversationService<S>>,
        runtime_registry: Arc<AgentConversationRuntimeRegistry>,
    ) -> Result<Self, ClaudeConversationHostErrorV1> {
        let client_generation = client_generation.into();
        if !safe_token(&client_generation) {
            return Err(ClaudeConversationHostErrorV1::new(
                "client_generation_invalid",
            ));
        }
        Ok(Self {
            attach_lock: AsyncMutex::new(()),
            client: AsyncMutex::new(None),
            client_attach_count: AtomicU32::new(0),
            client_generation,
            routes: Arc::new(RwLock::new(BTreeMap::new())),
            runtime_registry,
            service,
            supervisor: Mutex::new(ClaudeSdkHostSupervisor::new(configuration)),
        })
    }

    pub fn host_launch_count(&self) -> Result<u32, ClaudeConversationHostErrorV1> {
        Ok(self
            .supervisor
            .lock()
            .map_err(|_| ClaudeConversationHostErrorV1::new("supervisor_unavailable"))?
            .launch_count())
    }

    pub fn client_attach_count(&self) -> u32 {
        self.client_attach_count.load(Ordering::SeqCst)
    }

    pub(crate) async fn attachment_is_live(
        &self,
        identity: &ClaudeDch1QueryIdentity,
        host_identity: &ClaudeDch1HostIdentity,
    ) -> Result<bool, ClaudeConversationHostErrorV1> {
        let mut client = self.client.lock().await;
        let Some(connected) = client.as_ref() else {
            return Ok(false);
        };
        if connected.host_identity != *host_identity {
            return Ok(false);
        }
        if !self.connected_host_is_live(connected)? {
            *client = None;
            drop(client);
            self.retire_routes().await?;
            return Ok(false);
        }
        Ok(self.routes.read().await.contains_key(identity))
    }

    pub async fn attach(
        &self,
        attachment: ClaudeConversationAttachmentV1,
    ) -> Result<ClaudeConversationAttachmentReceiptV1, ClaudeConversationHostErrorV1> {
        let _attach_guard = self.attach_lock.lock().await;
        attachment
            .binding
            .validate()
            .map_err(|_| ClaudeConversationHostErrorV1::new("binding_invalid"))?;
        let cwd = exact_directory(&attachment.cwd)?;
        let identity = ClaudeDch1QueryIdentity {
            runtime_generation: attachment.binding.runtime.runtime_generation.clone(),
            query_epoch: attachment.binding.runtime.provider_epoch.clone(),
            relay_id: attachment.relay_id.clone(),
        };
        identity
            .validate()
            .map_err(|_| ClaudeConversationHostErrorV1::new("identity_invalid"))?;
        self.runtime_registry
            .preflight(&attachment.binding)
            .map_err(registry_error)?;
        let (client, host_process_id) = self.ensure_client().await?;

        let existing_route = self.routes.read().await.get(&identity).cloned();
        if let Some(route) = existing_route {
            if route.interaction_session_id != attachment.binding.interaction_session_id
                || route.permission_mode != attachment.permission_mode
                || route.model != attachment.model
                || route.effort != attachment.effort
            {
                return Err(ClaudeConversationHostErrorV1::new("identity_conflict"));
            }
            let host_identity = connected_host_identity(&client).await?;
            if let Err(error) = route.reconcile().await {
                let reason = bridge_error(error).reason;
                return Err(self
                    .failed_attachment_error(
                        &client,
                        &attachment.binding,
                        &identity,
                        &route,
                        reason,
                    )
                    .await);
            }
            let binding = match self
                .authoritative_attached_binding(&attachment.binding, &identity)
                .await
            {
                Ok(binding) => binding,
                Err(error) => {
                    return Err(self
                        .failed_attachment_error(
                            &client,
                            &attachment.binding,
                            &identity,
                            &route,
                            error.reason,
                        )
                        .await);
                }
            };
            let bridge = Arc::clone(&route.bridge);
            let commands: Arc<dyn AgentProviderCommands> = bridge;
            self.runtime_registry
                .register(binding.clone(), commands)
                .map_err(registry_error)?;
            return Ok(ClaudeConversationAttachmentReceiptV1 {
                binding,
                host_process_id,
                host_identity,
                identity,
            });
        }

        let bridge = Arc::new(
            ClaudeTimelineBridge::new(
                Arc::clone(&self.service),
                client.clone(),
                attachment.binding.interaction_session_id.clone(),
                identity.clone(),
            )
            .map_err(bridge_error)?,
        );
        let route = Arc::new(ConversationRoute {
            bridge: Arc::clone(&bridge),
            interaction_session_id: attachment.binding.interaction_session_id.clone(),
            permission_mode: attachment.permission_mode.clone(),
            model: attachment.model.clone(),
            effort: attachment.effort.clone(),
            reconcile_lock: AsyncMutex::new(()),
        });
        let replay_base = self
            .service
            .provider_cursor(
                &attachment.binding.interaction_session_id,
                &attachment.binding.runtime,
            )
            .await
            .map_err(|_| ClaudeConversationHostErrorV1::new("replay_base_unavailable"))?
            .committed_through_sequence;
        let mut query_binding = Map::new();
        query_binding.insert("identity".into(), json!(identity));
        query_binding.insert("cwd".into(), json!(cwd));
        let mut environment = attachment.environment;
        if let Some(home) = self.service.backend_home() {
            environment.insert(
                "DURE_ORCHESTRATION_HOME".into(),
                home.to_string_lossy().into_owned(),
            );
        }
        query_binding.insert("env".into(), json!(environment));
        query_binding.insert(
            "instructions".into(),
            json!(crate::agent_goal::tool_instructions(&attachment.binding.agent_id)),
        );
        query_binding.insert(
            "permissionMode".into(),
            Value::String(
                match attachment.permission_mode {
                    ProviderPermissionModeV1::Default => "default",
                    ProviderPermissionModeV1::AutoEdit => "auto_edit",
                    ProviderPermissionModeV1::SkipPermissions => "skip_permissions",
                }
                .into(),
            ),
        );
        if let Some(model) = attachment.model.as_ref() {
            query_binding.insert("model".into(), Value::String(model.as_str().into()));
        }
        if let Some(effort) = attachment.effort.as_ref() {
            query_binding.insert("effort".into(), Value::String(effort.as_str().into()));
        }
        if let Some(process) = attachment.process.as_ref() {
            query_binding.insert(
                "process".into(),
                json!({
                    "relayEndpoint": process.relay_endpoint,
                    "relayCapability": process.relay_capability,
                }),
            );
        }
        if let Some(provider_session_id) = attachment.binding.provider_conversation_ref.as_ref() {
            query_binding.insert(
                "providerSessionId".into(),
                Value::String(provider_session_id.clone()),
            );
        }
        let mut bind_options = Map::new();
        bind_options.insert("replayBase".into(), Value::from(replay_base));
        if let Some(authority) = attachment.replacement_authority {
            bind_options.insert("authority".into(), json!(authority));
        }
        let bind_result = client
            .request(
                "bind",
                json!({
                    "binding": Value::Object(query_binding),
                    "replacement": Value::Object(bind_options),
                }),
            )
            .await;
        let bind_receipt = match bind_result {
            Ok(receipt) => receipt,
            Err(error) => {
                let reason = format!("bind_{}", error.reason());
                if error.has_exact_retirement_candidate() {
                    return Err(self
                        .failed_attachment_error(
                            &client,
                            &attachment.binding,
                            &identity,
                            &route,
                            reason,
                        )
                        .await);
                }
                self.remove_route(&identity, &route).await;
                return Err(if error.is_remote_response() {
                    ClaudeConversationHostErrorV1::new(reason)
                } else {
                    ClaudeConversationHostErrorV1::attach_unknown(reason)
                });
            }
        };
        let bind_receipt: ClaudeQueryBindReceiptV1 = match serde_json::from_value(bind_receipt) {
            Ok(receipt) => receipt,
            Err(_) => {
                return Err(self
                    .failed_attachment_error(
                        &client,
                        &attachment.binding,
                        &identity,
                        &route,
                        "bind_receipt_invalid",
                    )
                    .await);
            }
        };
        if bind_receipt.identity != identity
            || bind_receipt.state != "waiting_for_input"
            || bind_receipt.host_identity.validate().is_err()
        {
            return Err(self
                .failed_attachment_error(
                    &client,
                    &attachment.binding,
                    &identity,
                    &route,
                    "bind_receipt_invalid",
                )
                .await);
        }
        let snapshot = match client.request("snapshot", json!({})).await {
            Ok(snapshot) => snapshot,
            Err(error) => {
                return Err(self
                    .failed_attachment_error(
                        &client,
                        &attachment.binding,
                        &identity,
                        &route,
                        format!("snapshot_{}", error.reason()),
                    )
                    .await);
            }
        };
        if let Err(error) = bridge.validate_attached_snapshot(&snapshot) {
            let reason = bridge_error(error).reason;
            return Err(self
                .failed_attachment_error(&client, &attachment.binding, &identity, &route, reason)
                .await);
        }
        let snapshot_host_identity = match host_identity_from_snapshot(snapshot) {
            Ok(identity) => identity,
            Err(error) => {
                return Err(self
                    .failed_attachment_error(
                        &client,
                        &attachment.binding,
                        &identity,
                        &route,
                        error.reason,
                    )
                    .await);
            }
        };
        if snapshot_host_identity != bind_receipt.host_identity {
            return Err(self
                .failed_attachment_error(
                    &client,
                    &attachment.binding,
                    &identity,
                    &route,
                    "bind_host_identity_conflict",
                )
                .await);
        }
        if let Err(error) = route.reconcile().await {
            let reason = bridge_error(error).reason;
            return Err(self
                .failed_attachment_error(&client, &attachment.binding, &identity, &route, reason)
                .await);
        }
        self.routes
            .write()
            .await
            .insert(identity.clone(), Arc::clone(&route));
        if let Err(error) = route.reconcile().await {
            let reason = bridge_error(error).reason;
            return Err(self
                .failed_attachment_error(&client, &attachment.binding, &identity, &route, reason)
                .await);
        }
        let binding = match self
            .authoritative_attached_binding(&attachment.binding, &identity)
            .await
        {
            Ok(binding) => binding,
            Err(error) => {
                return Err(self
                    .failed_attachment_error(
                        &client,
                        &attachment.binding,
                        &identity,
                        &route,
                        error.reason,
                    )
                    .await);
            }
        };
        let commands: Arc<dyn AgentProviderCommands> = bridge;
        if let Err(error) = self.runtime_registry.register(binding.clone(), commands) {
            let reason = registry_error(error).reason;
            return Err(self
                .failed_attachment_error(&client, &attachment.binding, &identity, &route, reason)
                .await);
        }
        Ok(ClaudeConversationAttachmentReceiptV1 {
            binding,
            host_process_id,
            host_identity: bind_receipt.host_identity,
            identity,
        })
    }

    /// Retire one exact Query and commit its terminal replay before removing
    /// the local route. The force/idle policy is the only provider-specific
    /// variation; both paths require the same exact DCH1 receipt.
    pub async fn retire(
        &self,
        binding: &AgentInteractionBindingV1,
        identity: &ClaudeDch1QueryIdentity,
        allowed_target: Option<&ClaudeDch1QueryIdentity>,
    ) -> Result<ClaudeDch1ProviderRetirementAuthority, ClaudeConversationHostErrorV1> {
        self.retire_with_action(binding, identity, allowed_target, "retire_query")
            .await
    }

    pub async fn retire_idle(
        &self,
        binding: &AgentInteractionBindingV1,
        identity: &ClaudeDch1QueryIdentity,
        allowed_target: Option<&ClaudeDch1QueryIdentity>,
    ) -> Result<ClaudeDch1ProviderRetirementAuthority, ClaudeConversationHostErrorV1> {
        self.retire_with_action(binding, identity, allowed_target, "retire_query_if_idle")
            .await
    }

    /// Reconciles durable retirement or exact provider-absence proof with
    /// either the current host's terminal Query state or a fresh host's empty
    /// state. The caller owns that proof before entering this boundary.
    pub async fn reconcile_proven_retirement(
        &self,
        binding: &AgentInteractionBindingV1,
        identity: &ClaudeDch1QueryIdentity,
        allowed_target: Option<&ClaudeDch1QueryIdentity>,
    ) -> Result<ClaudeDch1ProviderRetirementAuthority, ClaudeConversationHostErrorV1> {
        let _attach_guard = self.attach_lock.lock().await;
        if binding.runtime.runtime_generation != identity.runtime_generation
            || binding.runtime.provider_epoch != identity.query_epoch
        {
            return Err(ClaudeConversationHostErrorV1::new("identity_conflict"));
        }
        let route = self.routes.read().await.get(identity).cloned();
        if route
            .as_ref()
            .is_some_and(|route| route.interaction_session_id != binding.interaction_session_id)
        {
            return Err(ClaudeConversationHostErrorV1::new("identity_conflict"));
        }
        let (client, _) = self.ensure_client().await?;
        let authority = match self
            .retire_connected_query(
                &client,
                binding,
                identity,
                allowed_target,
                route.as_ref(),
                "retire_query",
            )
            .await
        {
            Ok(authority) => authority,
            Err(error) if error.reason() == "retire_remote_stale_query_identity" => {
                recover_retirement(&client, identity, allowed_target).await?
            }
            Err(error) if error.reason() == "retire_remote_retirement_authority_conflict" => {
                let current = retirement_status(&client, identity).await?;
                let Some(target) = allowed_target else {
                    return Err(error);
                };
                if !current.replay_committed
                    || current.authority.phase != ClaudeDch1ProviderRetirementPhase::Retired
                    || current.authority.allowed_target.is_some()
                {
                    return Err(error);
                }
                retarget_retirement(&client, &current.authority, target).await?
            }
            Err(error) => return Err(error),
        };
        if let Some(route) = self.routes.write().await.remove(identity) {
            drop(route);
        }
        self.runtime_registry
            .retire(&binding.interaction_session_id, &binding.runtime)
            .map_err(registry_error)?;
        Ok(authority)
    }

    async fn retire_with_action(
        &self,
        binding: &AgentInteractionBindingV1,
        identity: &ClaudeDch1QueryIdentity,
        allowed_target: Option<&ClaudeDch1QueryIdentity>,
        action: &str,
    ) -> Result<ClaudeDch1ProviderRetirementAuthority, ClaudeConversationHostErrorV1> {
        let _attach_guard = self.attach_lock.lock().await;
        if binding.runtime.runtime_generation != identity.runtime_generation
            || binding.runtime.provider_epoch != identity.query_epoch
        {
            return Err(ClaudeConversationHostErrorV1::new("identity_conflict"));
        }
        let route = self.routes.read().await.get(identity).cloned();
        if route
            .as_ref()
            .is_some_and(|route| route.interaction_session_id != binding.interaction_session_id)
        {
            return Err(ClaudeConversationHostErrorV1::new("identity_conflict"));
        }
        let (client, _) = self.ensure_client().await?;
        let authority = self
            .retire_connected_query(
                &client,
                binding,
                identity,
                allowed_target,
                route.as_ref(),
                action,
            )
            .await?;
        if let Some(route) = route.as_ref() {
            self.remove_route(identity, route).await;
        }
        self.runtime_registry
            .retire(&binding.interaction_session_id, &binding.runtime)
            .map_err(registry_error)?;
        Ok(authority)
    }

    async fn retire_connected_query(
        &self,
        client: &ClaudeDch1Client,
        binding: &AgentInteractionBindingV1,
        identity: &ClaudeDch1QueryIdentity,
        allowed_target: Option<&ClaudeDch1QueryIdentity>,
        route: Option<&Arc<ConversationRoute<S>>>,
        action: &str,
    ) -> Result<ClaudeDch1ProviderRetirementAuthority, ClaudeConversationHostErrorV1> {
        let receipt = retirement_receipt(
            client
                .request(
                    action,
                    json!({
                        "identity": identity,
                        "retirement": { "allowedTarget": allowed_target },
                    }),
                )
                .await
                .map_err(|error| {
                    let reason = format!("retire_{}", error.reason());
                    if error.is_query_busy() {
                        ClaudeConversationHostErrorV1::source_busy(reason)
                    } else {
                        ClaudeConversationHostErrorV1::new(reason)
                    }
                })?,
            identity,
        )?;
        if !receipt.replay_committed {
            self.commit_retirement_replay(client, binding, identity, route)
                .await?;
        }
        let committed = retirement_status(client, identity).await?;
        if !committed.replay_committed {
            return Err(ClaudeConversationHostErrorV1::new(
                "retirement_replay_uncommitted",
            ));
        }
        if committed.authority != receipt.authority {
            return Err(ClaudeConversationHostErrorV1::new(
                "retirement_authority_conflict",
            ));
        }
        Ok(committed.authority)
    }

    async fn commit_retirement_replay(
        &self,
        client: &ClaudeDch1Client,
        binding: &AgentInteractionBindingV1,
        identity: &ClaudeDch1QueryIdentity,
        route: Option<&Arc<ConversationRoute<S>>>,
    ) -> Result<(), ClaudeConversationHostErrorV1> {
        if let Some(route) = route {
            let _guard = route.reconcile_lock.lock().await;
            if retirement_status(client, identity).await?.replay_committed {
                return Ok(());
            }
            if let Err(error) = route.bridge.reconcile_retired_provider_projection().await {
                if retirement_status(client, identity).await?.replay_committed {
                    return Ok(());
                }
                return Err(bridge_error(error));
            }
        } else {
            if retirement_status(client, identity).await?.replay_committed {
                return Ok(());
            }
            ClaudeTimelineBridge::new(
                Arc::clone(&self.service),
                client.clone(),
                binding.interaction_session_id.clone(),
                identity.clone(),
            )
            .map_err(bridge_error)?
            .reconcile_retired_provider_projection()
            .await
            .map_err(bridge_error)?;
        }
        Ok(())
    }

    /// Release a provider tombstone only after the durable launch journal says
    /// the exact Query retirement no longer needs to fence a successor bind.
    pub async fn release_retirement(
        &self,
        authority: &ClaudeDch1ProviderRetirementAuthority,
    ) -> Result<ClaudeDch1ProviderRetirementAuthority, ClaudeConversationHostErrorV1> {
        let _attach_guard = self.attach_lock.lock().await;
        authority
            .validate()
            .map_err(|_| ClaudeConversationHostErrorV1::new("retirement_authority_invalid"))?;
        let (client, _) = self.ensure_client().await?;
        let value = client
            .request(
                "release_query_retirement",
                json!({ "authority": authority }),
            )
            .await
            .map_err(|error| {
                ClaudeConversationHostErrorV1::new(format!("release_retirement_{}", error.reason()))
            })?;
        let receipt: ClaudeQueryRetirementReleaseReceiptV1 = serde_json::from_value(value)
            .map_err(|_| {
                ClaudeConversationHostErrorV1::new("release_retirement_receipt_invalid")
            })?;
        if !matches!(
            receipt.outcome,
            ClaudeQueryRetirementReleaseOutcomeV1::Released
                | ClaudeQueryRetirementReleaseOutcomeV1::AlreadyReleased
        ) || !valid_released_authority_receipt(authority, &receipt.authority)
        {
            return Err(ClaudeConversationHostErrorV1::new(
                "release_retirement_receipt_invalid",
            ));
        }
        Ok(receipt.authority)
    }

    pub async fn confirm_retirement_release(
        &self,
        authority: &ClaudeDch1ProviderRetirementAuthority,
    ) -> Result<(), ClaudeConversationHostErrorV1> {
        let _attach_guard = self.attach_lock.lock().await;
        if authority.phase != ClaudeDch1ProviderRetirementPhase::Released
            || authority.validate().is_err()
        {
            return Err(ClaudeConversationHostErrorV1::new(
                "retirement_authority_invalid",
            ));
        }
        let (client, _) = self.ensure_client().await?;
        let value = client
            .request(
                "confirm_query_retirement_release",
                json!({ "authority": authority }),
            )
            .await
            .map_err(|error| {
                ClaudeConversationHostErrorV1::new(format!(
                    "confirm_retirement_release_{}",
                    error.reason()
                ))
            })?;
        let receipt: ClaudeQueryRetirementConfirmReceiptV1 = serde_json::from_value(value)
            .map_err(|_| {
                ClaudeConversationHostErrorV1::new("confirm_retirement_receipt_invalid")
            })?;
        if receipt.authority != *authority
            || !matches!(
                receipt.outcome,
                ClaudeQueryRetirementConfirmOutcomeV1::Confirmed
                    | ClaudeQueryRetirementConfirmOutcomeV1::AlreadyAbsent
            )
        {
            return Err(ClaudeConversationHostErrorV1::new(
                "confirm_retirement_receipt_invalid",
            ));
        }
        Ok(())
    }

    pub async fn commit_replacement(
        &self,
        authority: &ClaudeDch1ProviderRetirementAuthority,
        target: &ClaudeDch1QueryIdentity,
    ) -> Result<ClaudeDch1ProviderRetirementAuthority, ClaudeConversationHostErrorV1> {
        let _attach_guard = self.attach_lock.lock().await;
        let (client, _) = self.ensure_client().await?;
        let value = client
            .request(
                "commit_query_replacement",
                json!({ "authority": authority, "target": target }),
            )
            .await
            .map_err(|error| {
                ClaudeConversationHostErrorV1::new(format!("commit_replacement_{}", error.reason()))
            })?;
        let receipt: ClaudeQueryReplacementCommitReceiptV1 = serde_json::from_value(value)
            .map_err(|_| {
                ClaudeConversationHostErrorV1::new("commit_replacement_receipt_invalid")
            })?;
        if receipt.outcome != ClaudeQueryReplacementCommitOutcomeV1::TargetBound
            || receipt.authority.source != authority.source
            || receipt.authority.allowed_target.as_ref() != Some(target)
            || receipt.authority.source_host != authority.source_host
            || receipt.authority.phase != ClaudeDch1ProviderRetirementPhase::TargetBound
            || receipt.authority.validate().is_err()
        {
            return Err(ClaudeConversationHostErrorV1::new(
                "commit_replacement_receipt_invalid",
            ));
        }
        Ok(receipt.authority)
    }

    pub async fn retarget_retirement(
        &self,
        authority: &ClaudeDch1ProviderRetirementAuthority,
        target: &ClaudeDch1QueryIdentity,
    ) -> Result<ClaudeDch1ProviderRetirementAuthority, ClaudeConversationHostErrorV1> {
        let _attach_guard = self.attach_lock.lock().await;
        let (client, _) = self.ensure_client().await?;
        retarget_retirement(&client, authority, target).await
    }

    async fn ensure_client(
        &self,
    ) -> Result<(ClaudeDch1Client, u32), ClaudeConversationHostErrorV1> {
        let mut client = self.client.lock().await;
        if let Some(connected) = client.as_ref() {
            if self.connected_host_is_live(connected)? {
                return Ok((connected.client.clone(), connected.process_id));
            }
            *client = None;
            self.retire_routes().await?;
        }
        let lease = self
            .supervisor
            .lock()
            .map_err(|_| ClaudeConversationHostErrorV1::new("supervisor_unavailable"))?
            .ensure_started()
            .map_err(|error| {
                // The supervisor knows why the host died; without this the
                // recorded failure is a code with no cause.
                ClaudeConversationHostErrorV1::new(format!("supervisor_{}", error.reason()))
                    .with_detail(error.detail())
            })?;
        let host_process_id = lease.process_id();
        let attached = ClaudeDch1Client::connect(&lease, &self.client_generation, BTreeMap::new())
            .await
            .map_err(|error| {
                // Failure to acquire a controller connection says nothing
                // about an existing Query; it cannot authorize retiring it.
                ClaudeConversationHostErrorV1::attach_unknown(format!("connect_{}", error.reason()))
            })?;
        let AttachedClaudeDch1Client {
            client: connected,
            snapshot,
            events,
            terminal: _,
        } = attached;
        let host_identity = host_identity_from_snapshot(snapshot)?;
        spawn_event_router(Arc::downgrade(&self.routes), events);
        self.client_attach_count.fetch_add(1, Ordering::SeqCst);
        *client = Some(ConnectedClaudeSdkHost {
            client: connected.clone(),
            host_identity,
            process_id: host_process_id,
        });
        Ok((connected, host_process_id))
    }

    fn connected_host_is_live(
        &self,
        connected: &ConnectedClaudeSdkHost,
    ) -> Result<bool, ClaudeConversationHostErrorV1> {
        if connected.client.terminal().borrow().is_some() {
            return Ok(false);
        }
        let mut supervisor = self
            .supervisor
            .lock()
            .map_err(|_| ClaudeConversationHostErrorV1::new("supervisor_unavailable"))?;
        supervisor
            .owns_live_process(connected.process_id)
            .map_err(|error| {
                // The supervisor knows why the host died; without this the
                // recorded failure is a code with no cause.
                ClaudeConversationHostErrorV1::new(format!("supervisor_{}", error.reason()))
                    .with_detail(error.detail())
            })
    }

    async fn retire_routes(&self) -> Result<(), ClaudeConversationHostErrorV1> {
        let routes = std::mem::take(&mut *self.routes.write().await);
        for (identity, route) in routes {
            self.runtime_registry
                .retire(
                    &route.interaction_session_id,
                    &AgentProviderRuntimeFenceV1 {
                        runtime_generation: identity.runtime_generation,
                        provider_epoch: identity.query_epoch,
                    },
                )
                .map_err(registry_error)?;
        }
        Ok(())
    }

    async fn close_failed_query(
        &self,
        client: &ClaudeDch1Client,
        binding: &AgentInteractionBindingV1,
        identity: &ClaudeDch1QueryIdentity,
        route: &Arc<ConversationRoute<S>>,
    ) -> Result<ClaudeDch1ProviderRetirementAuthority, ClaudeConversationHostErrorV1> {
        let authority = self
            .retire_connected_query(client, binding, identity, None, Some(route), "retire_query")
            .await?;
        self.remove_route(identity, route).await;
        self.runtime_registry
            .retire(&binding.interaction_session_id, &binding.runtime)
            .map_err(registry_error)?;
        Ok(authority)
    }

    async fn authoritative_attached_binding(
        &self,
        requested: &AgentInteractionBindingV1,
        identity: &ClaudeDch1QueryIdentity,
    ) -> Result<AgentInteractionBindingV1, ClaudeConversationHostErrorV1> {
        let current = self
            .service
            .binding(&requested.interaction_session_id)
            .await
            .map_err(|_| ClaudeConversationHostErrorV1::new("binding_refresh_failed"))?
            .ok_or_else(|| ClaudeConversationHostErrorV1::new("binding_refresh_missing"))?;
        if !requested.same_runtime_authority(&current)
            || current.runtime.runtime_generation != identity.runtime_generation
            || current.runtime.provider_epoch != identity.query_epoch
        {
            return Err(ClaudeConversationHostErrorV1::new(
                "binding_refresh_conflict",
            ));
        }
        Ok(current)
    }

    async fn failed_attachment_error(
        &self,
        client: &ClaudeDch1Client,
        binding: &AgentInteractionBindingV1,
        identity: &ClaudeDch1QueryIdentity,
        route: &Arc<ConversationRoute<S>>,
        reason: impl Into<String>,
    ) -> ClaudeConversationHostErrorV1 {
        let reason = reason.into();
        match self
            .close_failed_query(client, binding, identity, route)
            .await
        {
            Ok(authority) => ClaudeConversationHostErrorV1::attach_retired(reason, authority),
            Err(_) => ClaudeConversationHostErrorV1::attach_unknown(reason),
        }
    }

    async fn remove_route(
        &self,
        identity: &ClaudeDch1QueryIdentity,
        route: &Arc<ConversationRoute<S>>,
    ) {
        let mut routes = self.routes.write().await;
        if routes
            .get(identity)
            .is_some_and(|current| Arc::ptr_eq(current, route))
        {
            routes.remove(identity);
        }
    }
}

fn valid_released_authority_receipt(
    requested: &ClaudeDch1ProviderRetirementAuthority,
    released: &ClaudeDch1ProviderRetirementAuthority,
) -> bool {
    released.source == requested.source
        && released.allowed_target == requested.allowed_target
        && released.source_host == requested.source_host
        && released.phase == ClaudeDch1ProviderRetirementPhase::Released
        && released.validate().is_ok()
        && match requested.phase {
            ClaudeDch1ProviderRetirementPhase::Retired => requested.target_host.is_none(),
            ClaudeDch1ProviderRetirementPhase::TargetBound => {
                released.target_host == requested.target_host
            }
            ClaudeDch1ProviderRetirementPhase::Released => false,
        }
}

fn spawn_event_router<S>(
    routes: Weak<RwLock<RouteMap<S>>>,
    mut events: broadcast::Receiver<crate::claude_sdk_host_client::ClaudeDch1EventFrame>,
) where
    S: AgentTimelineStore + 'static,
{
    tokio::spawn(async move {
        loop {
            let event = events.recv().await;
            let Some(routes) = routes.upgrade() else {
                break;
            };
            match event {
                Ok(frame) => {
                    let route = routes.read().await.get(&frame.identity).cloned();
                    if let Some(route) = route {
                        let _ = route.ingest(&frame).await;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    let active = routes.read().await.values().cloned().collect::<Vec<_>>();
                    for route in active {
                        let _ = route.reconcile().await;
                    }
                }
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });
}

fn registry_error(error: AgentConversationApiErrorV1) -> ClaudeConversationHostErrorV1 {
    ClaudeConversationHostErrorV1::new(format!("registry_{}", error.code()))
}

fn bridge_error(error: ClaudeTimelineBridgeError) -> ClaudeConversationHostErrorV1 {
    ClaudeConversationHostErrorV1::new(format!("bridge_{}", error.reason()))
}

fn retirement_receipt(
    value: Value,
    identity: &ClaudeDch1QueryIdentity,
) -> Result<ClaudeQueryRetirementReceiptV1, ClaudeConversationHostErrorV1> {
    let receipt: ClaudeQueryRetirementReceiptV1 = serde_json::from_value(value)
        .map_err(|_| ClaudeConversationHostErrorV1::new("retirement_receipt_invalid"))?;
    if receipt.identity != *identity
        || receipt.authority.source != *identity
        || receipt.authority.phase != ClaudeDch1ProviderRetirementPhase::Retired
        || receipt.authority.validate().is_err()
        || !matches!(
            receipt.outcome,
            ClaudeQueryRetirementOutcomeV1::Retired
                | ClaudeQueryRetirementOutcomeV1::AlreadyRetired
        )
    {
        return Err(ClaudeConversationHostErrorV1::new(
            "retirement_receipt_invalid",
        ));
    }
    Ok(receipt)
}

async fn connected_host_identity(
    client: &ClaudeDch1Client,
) -> Result<ClaudeDch1HostIdentity, ClaudeConversationHostErrorV1> {
    host_identity_from_snapshot(
        client
            .request("snapshot", json!({}))
            .await
            .map_err(|error| {
                ClaudeConversationHostErrorV1::new(format!(
                    "snapshot_host_identity_{}",
                    error.reason()
                ))
            })?,
    )
}

fn host_identity_from_snapshot(
    snapshot: Value,
) -> Result<ClaudeDch1HostIdentity, ClaudeConversationHostErrorV1> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct HostSnapshot {
        host_generation: String,
        host_instance_id: String,
    }

    let snapshot: HostSnapshot = serde_json::from_value(snapshot)
        .map_err(|_| ClaudeConversationHostErrorV1::new("snapshot_host_identity_invalid"))?;
    let identity = ClaudeDch1HostIdentity {
        host_generation: snapshot.host_generation,
        host_instance_id: snapshot.host_instance_id,
    };
    identity
        .validate()
        .map_err(|_| ClaudeConversationHostErrorV1::new("snapshot_host_identity_invalid"))?;
    Ok(identity)
}

async fn retirement_status(
    client: &ClaudeDch1Client,
    identity: &ClaudeDch1QueryIdentity,
) -> Result<ClaudeQueryRetirementReceiptV1, ClaudeConversationHostErrorV1> {
    retirement_receipt(
        client
            .request("query_retirement_status", json!({ "identity": identity }))
            .await
            .map_err(|error| {
                ClaudeConversationHostErrorV1::new(format!("retirement_status_{}", error.reason()))
            })?,
        identity,
    )
}

async fn recover_retirement(
    client: &ClaudeDch1Client,
    identity: &ClaudeDch1QueryIdentity,
    allowed_target: Option<&ClaudeDch1QueryIdentity>,
) -> Result<ClaudeDch1ProviderRetirementAuthority, ClaudeConversationHostErrorV1> {
    let value = client
        .request(
            "recover_query_retirement",
            json!({
                "identity": identity,
                "retirement": { "allowedTarget": allowed_target },
            }),
        )
        .await
        .map_err(|error| {
            ClaudeConversationHostErrorV1::new(format!("recover_retirement_{}", error.reason()))
        })?;
    let receipt: ClaudeQueryRetirementRecoveryReceiptV1 = serde_json::from_value(value)
        .map_err(|_| ClaudeConversationHostErrorV1::new("retirement_recovery_receipt_invalid"))?;
    if receipt.identity != *identity
        || receipt.authority.source != *identity
        || receipt.authority.allowed_target.as_ref() != allowed_target
        || receipt.authority.phase != ClaudeDch1ProviderRetirementPhase::Retired
        || !receipt.replay_committed
        || receipt.authority.validate().is_err()
        || receipt.outcome != ClaudeQueryRetirementRecoveryOutcomeV1::Recovered
    {
        return Err(ClaudeConversationHostErrorV1::new(
            "retirement_recovery_receipt_invalid",
        ));
    }
    Ok(receipt.authority)
}

async fn retarget_retirement(
    client: &ClaudeDch1Client,
    authority: &ClaudeDch1ProviderRetirementAuthority,
    target: &ClaudeDch1QueryIdentity,
) -> Result<ClaudeDch1ProviderRetirementAuthority, ClaudeConversationHostErrorV1> {
    let value = client
        .request(
            "retarget_query_retirement",
            json!({ "authority": authority, "target": target }),
        )
        .await
        .map_err(|error| {
            ClaudeConversationHostErrorV1::new(format!("retarget_retirement_{}", error.reason()))
        })?;
    let receipt: ClaudeQueryRetirementRetargetReceiptV1 = serde_json::from_value(value)
        .map_err(|_| ClaudeConversationHostErrorV1::new("retarget_retirement_receipt_invalid"))?;
    if receipt.outcome != ClaudeQueryRetirementRetargetOutcomeV1::Retargeted
        || receipt.authority.source != authority.source
        || receipt.authority.allowed_target.as_ref() != Some(target)
        || receipt.authority.source_host != authority.source_host
        || receipt.authority.phase != ClaudeDch1ProviderRetirementPhase::Retired
        || receipt.authority.validate().is_err()
    {
        return Err(ClaudeConversationHostErrorV1::new(
            "retarget_retirement_receipt_invalid",
        ));
    }
    Ok(receipt.authority)
}

fn exact_directory(path: &Path) -> Result<PathBuf, ClaudeConversationHostErrorV1> {
    if !path.is_absolute() {
        return Err(ClaudeConversationHostErrorV1::new("cwd_invalid"));
    }
    let canonical = path
        .canonicalize()
        .map_err(|_| ClaudeConversationHostErrorV1::new("cwd_invalid"))?;
    if !canonical.is_dir() {
        return Err(ClaudeConversationHostErrorV1::new("cwd_invalid"));
    }
    Ok(canonical)
}

fn safe_token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn authority(
        phase: ClaudeDch1ProviderRetirementPhase,
    ) -> ClaudeDch1ProviderRetirementAuthority {
        ClaudeDch1ProviderRetirementAuthority {
            source: ClaudeDch1QueryIdentity {
                runtime_generation: "runtime-source".into(),
                query_epoch: "query-source".into(),
                relay_id: "relay-source".into(),
            },
            allowed_target: Some(ClaudeDch1QueryIdentity {
                runtime_generation: "runtime-target".into(),
                query_epoch: "query-target".into(),
                relay_id: "relay-target".into(),
            }),
            source_host: ClaudeDch1HostIdentity {
                host_generation: "host-source".into(),
                host_instance_id: "instance-source".into(),
            },
            target_host: (phase != ClaudeDch1ProviderRetirementPhase::Retired).then(|| {
                ClaudeDch1HostIdentity {
                    host_generation: "host-target".into(),
                    host_instance_id: "instance-target".into(),
                }
            }),
            phase,
        }
    }

    #[test]
    fn released_receipt_accepts_monotonic_target_host_discovered_after_a_lost_commit_response() {
        let requested = authority(ClaudeDch1ProviderRetirementPhase::Retired);
        let released = authority(ClaudeDch1ProviderRetirementPhase::Released);
        assert!(valid_released_authority_receipt(&requested, &released));

        let requested = authority(ClaudeDch1ProviderRetirementPhase::TargetBound);
        assert!(valid_released_authority_receipt(&requested, &released));

        let mut wrong_lineage = released.clone();
        wrong_lineage.target_host.as_mut().unwrap().host_instance_id = "other-instance".into();
        assert!(!valid_released_authority_receipt(
            &authority(ClaudeDch1ProviderRetirementPhase::TargetBound),
            &wrong_lineage,
        ));
    }
}
