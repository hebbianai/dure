use std::{collections::BTreeMap, fmt, future::Future, pin::Pin, sync::Arc, time::Duration};

use crate::{
    AgentCheckpointBindingAuthorityV1, ExtensionContractV1, ExtensionFailureCodeV1, ExtensionIdV1,
    ExtensionImplementation, ExtensionRegistry, HostCompatibilityV1, RegistrationOutcomeV1,
    RuntimeKindIdV1,
};

pub type RuntimeAdapterFutureV1<T> = Pin<Box<dyn Future<Output = T> + Send + 'static>>;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeSessionProbeReceiptV1 {
    pub runtime_kind_id: RuntimeKindIdV1,
    pub session_id: String,
    pub workspace_id: String,
}

/// The first production RuntimeAdapter capability.
///
/// The durable binding is only a lookup hint. Implementations must probe the
/// runtime authority and verify every exact fence before returning success.
pub trait RuntimeAdapterImplementation: ExtensionImplementation {
    fn probe_session(
        &self,
        authority: AgentCheckpointBindingAuthorityV1,
    ) -> RuntimeAdapterFutureV1<Result<RuntimeSessionProbeReceiptV1, ExtensionFailureCodeV1>>;
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RuntimeAdapterRegistrationErrorV1 {
    WrongExtensionFamily {
        extension_id: ExtensionIdV1,
    },
    DuplicateRuntimeKind {
        runtime_kind_id: RuntimeKindIdV1,
        existing_extension_id: ExtensionIdV1,
    },
}

impl fmt::Display for RuntimeAdapterRegistrationErrorV1 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::WrongExtensionFamily { extension_id } => write!(
                formatter,
                "extension {} is not a runtime adapter",
                extension_id.as_str()
            ),
            Self::DuplicateRuntimeKind {
                runtime_kind_id,
                existing_extension_id,
            } => write!(
                formatter,
                "runtime kind {} is already owned by extension {}",
                runtime_kind_id.as_str(),
                existing_extension_id.as_str()
            ),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeAdapterOperationErrorV1 {
    pub extension_id: ExtensionIdV1,
    pub runtime_kind_id: RuntimeKindIdV1,
    pub code: ExtensionFailureCodeV1,
}

impl fmt::Display for RuntimeAdapterOperationErrorV1 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "runtime adapter extension {} failed {} for {}",
            self.extension_id.as_str(),
            self.code.as_str(),
            self.runtime_kind_id.as_str()
        )
    }
}

struct RegisteredRuntimeAdapter {
    extension_id: ExtensionIdV1,
    implementation: Arc<dyn RuntimeAdapterImplementation>,
}

#[derive(Default)]
pub struct RuntimeAdapterRegistry {
    extensions: ExtensionRegistry,
    runtimes: BTreeMap<RuntimeKindIdV1, RegisteredRuntimeAdapter>,
}

impl RuntimeAdapterRegistry {
    pub fn extension_count(&self) -> usize {
        self.extensions.len()
    }

    pub fn runtime_count(&self) -> usize {
        self.runtimes.len()
    }

    pub fn contains_runtime_kind(&self, runtime_kind_id: &RuntimeKindIdV1) -> bool {
        self.runtimes.contains_key(runtime_kind_id)
    }

    pub fn register<T>(
        &mut self,
        implementation: Arc<T>,
        host: &HostCompatibilityV1,
        probe_timeout: Duration,
    ) -> Result<RegistrationOutcomeV1, RuntimeAdapterRegistrationErrorV1>
    where
        T: RuntimeAdapterImplementation + 'static,
    {
        let descriptor = implementation.descriptor();
        if let Err(error) = descriptor.validate() {
            return Ok(RegistrationOutcomeV1::InvalidDescriptor {
                message: error.to_string(),
            });
        }
        let runtime_kinds = match &descriptor.extension {
            ExtensionContractV1::RuntimeAdapter(contract) => contract.runtime_kinds.clone(),
            _ => {
                return Err(RuntimeAdapterRegistrationErrorV1::WrongExtensionFamily {
                    extension_id: descriptor.id.clone(),
                });
            }
        };
        if self.extensions.get(&descriptor.id).is_some() {
            return Ok(RegistrationOutcomeV1::DuplicateId {
                id: descriptor.id.clone(),
            });
        }
        for runtime_kind_id in &runtime_kinds {
            if let Some(existing) = self.runtimes.get(runtime_kind_id) {
                return Err(RuntimeAdapterRegistrationErrorV1::DuplicateRuntimeKind {
                    runtime_kind_id: runtime_kind_id.clone(),
                    existing_extension_id: existing.extension_id.clone(),
                });
            }
        }

        let base_implementation: Arc<dyn ExtensionImplementation> = implementation.clone();
        let outcome = self
            .extensions
            .register(base_implementation, host, probe_timeout);
        if matches!(outcome, RegistrationOutcomeV1::Registered(_)) {
            let extension_id = implementation.descriptor().id.clone();
            let runtime_implementation: Arc<dyn RuntimeAdapterImplementation> = implementation;
            for runtime_kind_id in runtime_kinds {
                self.runtimes.insert(
                    runtime_kind_id,
                    RegisteredRuntimeAdapter {
                        extension_id: extension_id.clone(),
                        implementation: Arc::clone(&runtime_implementation),
                    },
                );
            }
        }
        Ok(outcome)
    }

    pub async fn probe_session(
        &self,
        authority: AgentCheckpointBindingAuthorityV1,
    ) -> Result<Option<RuntimeSessionProbeReceiptV1>, RuntimeAdapterOperationErrorV1> {
        let runtime_kind_id = authority.binding.runtime_kind_id.clone();
        let Some(runtime) = self.runtimes.get(&runtime_kind_id) else {
            return Ok(None);
        };
        if authority.validate().is_err() {
            return Err(RuntimeAdapterOperationErrorV1 {
                extension_id: runtime.extension_id.clone(),
                runtime_kind_id,
                code: ExtensionFailureCodeV1::new("session_probe_request_invalid")
                    .expect("static failure code is valid"),
            });
        }
        let expected_session_id = authority.binding.session_id.clone();
        let expected_workspace_id = authority.runtime_workspace_id.clone();
        let receipt = runtime
            .implementation
            .probe_session(authority)
            .await
            .map_err(|code| RuntimeAdapterOperationErrorV1 {
                extension_id: runtime.extension_id.clone(),
                runtime_kind_id: runtime_kind_id.clone(),
                code,
            })?;
        if receipt.runtime_kind_id != runtime_kind_id
            || receipt.session_id != expected_session_id
            || receipt.workspace_id != expected_workspace_id
        {
            return Err(RuntimeAdapterOperationErrorV1 {
                extension_id: runtime.extension_id.clone(),
                runtime_kind_id,
                code: ExtensionFailureCodeV1::new("session_probe_receipt_mismatch")
                    .expect("static failure code is valid"),
            });
        }
        Ok(Some(receipt))
    }
}
