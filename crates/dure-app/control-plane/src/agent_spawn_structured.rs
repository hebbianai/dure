use std::sync::Arc;

use dure_app::{AGENT_TIMELINE_SCHEMA_VERSION_V1, AgentStartTurnIntentV1};
use dure_app_sqlite::SqliteDomainStore;

use crate::agent_conversation_api::AgentConversationApi;
use crate::agent_spawn_apply::{
    StructuredAgentLaunchFailure, StructuredAgentLaunchRequest, StructuredAgentPromptRequest,
    StructuredAgentSessionLauncher, StructuredLaunchFuture, StructuredPromptFuture,
};
use crate::structured_provider_runtime::{
    StructuredProviderOpenRequestV1, StructuredProviderRuntime,
};

/// Composition between the provider-neutral spawn journal and one registered
/// structured provider runtime.
pub(crate) struct RegisteredStructuredAgentSessionLauncher {
    runtime: Arc<dyn StructuredProviderRuntime>,
    conversations: Arc<AgentConversationApi<SqliteDomainStore>>,
}

impl RegisteredStructuredAgentSessionLauncher {
    pub(crate) fn new(
        runtime: Arc<dyn StructuredProviderRuntime>,
        conversations: Arc<AgentConversationApi<SqliteDomainStore>>,
    ) -> Self {
        Self {
            runtime,
            conversations,
        }
    }
}

impl StructuredAgentSessionLauncher for RegisteredStructuredAgentSessionLauncher {
    fn launch(&self, request: StructuredAgentLaunchRequest) -> StructuredLaunchFuture<'_> {
        Box::pin(async move {
            self.runtime
                .open(StructuredProviderOpenRequestV1 {
                    agent_id: request.agent_id,
                    execution_profile: request.execution_profile,
                    permission_mode: request.permission_mode,
                    model: request.model,
                    effort: request.effort,
                    provider_conversation_ref: request
                        .provider_conversation_ref
                        .as_option()
                        .map(str::to_string),
                })
                .await
                .map_err(|error| failure_with_detail(error.code, error.detail))
        })
    }

    fn start_turn(&self, request: StructuredAgentPromptRequest) -> StructuredPromptFuture<'_> {
        Box::pin(async move {
            self.conversations
                .start_turn_intent(&AgentStartTurnIntentV1 {
                    schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
                    interaction_session_id: request.binding.interaction_session_id,
                    runtime: request.binding.runtime,
                    turn_id: request.turn_id,
                    client_message_id: request.client_message_id,
                    input: request.input,
                    requested_at_ms: request.requested_at_ms,
                })
                .await
                .map_err(|error| failure(error.code()))
        })
    }
}

fn failure(code: impl Into<String>) -> StructuredAgentLaunchFailure {
    StructuredAgentLaunchFailure {
        code: code.into(),
        detail: None,
    }
}

fn failure_with_detail(
    code: impl Into<String>,
    detail: Option<String>,
) -> StructuredAgentLaunchFailure {
    StructuredAgentLaunchFailure {
        code: code.into(),
        detail,
    }
}
