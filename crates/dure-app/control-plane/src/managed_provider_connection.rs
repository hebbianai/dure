use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use dure_app::AgentInteractionBindingV1;

use crate::agent_conversation::AgentProviderCommands;

/// Provider-owned liveness and admission on one exact managed generation.
/// Process retirement remains the managed runtime's responsibility.
pub(crate) trait ManagedProviderConnection: AgentProviderCommands {
    fn is_connected(&self) -> bool;
    fn begin_idle_drain(&self) -> Pin<Box<dyn Future<Output = bool> + Send + '_>>;
    fn cancel_drain(&self);
}

pub(crate) struct AttachedProviderConnection {
    pub(crate) binding: AgentInteractionBindingV1,
    pub(crate) connection: Arc<dyn ManagedProviderConnection>,
    pub(crate) commands: Arc<dyn AgentProviderCommands>,
    pub(crate) handler: tokio::task::JoinHandle<()>,
}
