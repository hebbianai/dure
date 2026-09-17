use std::collections::HashMap;
use std::sync::{Arc, Mutex as RegistryMutex, Weak};

use dure_app::AgentIdV1;
use tokio::sync::{Mutex, OwnedMutexGuard};

/// Serializes mutations of one logical Agent without blocking unrelated
/// Agents. Weak entries disappear on the next acquisition after their last
/// operation completes, so the registry does not retain historical Agent IDs.
#[derive(Clone, Default)]
pub(crate) struct AgentOperationLocks {
    entries: Arc<RegistryMutex<HashMap<String, Weak<Mutex<()>>>>>,
}

impl AgentOperationLocks {
    pub(crate) async fn acquire(&self, agent_id: &AgentIdV1) -> OwnedMutexGuard<()> {
        let operation = {
            let mut entries = self
                .entries
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            entries.retain(|_, operation| operation.strong_count() > 0);
            if let Some(operation) = entries.get(agent_id.as_str()).and_then(Weak::upgrade) {
                operation
            } else {
                let operation = Arc::new(Mutex::new(()));
                entries.insert(agent_id.as_str().into(), Arc::downgrade(&operation));
                operation
            }
        };
        operation.lock_owned().await
    }

    pub(crate) async fn acquire_all(
        &self,
        mut agent_ids: Vec<AgentIdV1>,
    ) -> Vec<OwnedMutexGuard<()>> {
        agent_ids.sort();
        agent_ids.dedup();
        let mut guards = Vec::with_capacity(agent_ids.len());
        for agent_id in &agent_ids {
            guards.push(self.acquire(agent_id).await);
        }
        guards
    }
}
