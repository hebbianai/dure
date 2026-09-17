use std::{sync::Arc, time::Duration};

use dure_app::{
    AgentCheckpointBindingAuthorityV1, ApiVersionRangeV1, CapabilityDeclarationV1, CapabilityIdV1,
    EXTENSION_DESCRIPTOR_SCHEMA_VERSION, ExtensionContractV1, ExtensionDescriptorV1,
    ExtensionFailureCodeV1, ExtensionIdV1, ExtensionImplementation, ExtensionProbeContextV1,
    ExtensionProbeOutcomeV1, HostCompatibilityV1, RegistrationOutcomeV1, RuntimeAdapterContractV1,
    RuntimeAdapterFutureV1, RuntimeAdapterImplementation, RuntimeAdapterRegistry, RuntimeKindIdV1,
    RuntimeSessionProbeReceiptV1,
};

use crate::{HmuxStopFence, HmuxToolchainIdentity, query_hmux};

const LOCAL_HMUX_RUNTIME_KIND: &str = "runtime.hmux";
const BUNDLED_PROBE_TIMEOUT: Duration = Duration::from_millis(50);

struct LocalHmuxRuntimeAdapter {
    descriptor: ExtensionDescriptorV1,
    hmux_identity: HmuxToolchainIdentity,
}

impl LocalHmuxRuntimeAdapter {
    fn new(hmux_identity: HmuxToolchainIdentity) -> Self {
        Self {
            descriptor: ExtensionDescriptorV1 {
                schema_version: EXTENSION_DESCRIPTOR_SCHEMA_VERSION,
                id: ExtensionIdV1::new("dure.bundled.local-hmux")
                    .expect("static extension ID is valid"),
                display_name: "Dure bundled local Hmux runtime".into(),
                api: ApiVersionRangeV1::current_and_previous(),
                capabilities: CapabilityDeclarationV1 {
                    provided: vec![
                        CapabilityIdV1::new("runtime.session-probe")
                            .expect("static capability ID is valid"),
                    ],
                    required: Vec::new(),
                    optional: Vec::new(),
                },
                permissions: Vec::new(),
                extension: ExtensionContractV1::RuntimeAdapter(RuntimeAdapterContractV1 {
                    runtime_kinds: vec![
                        RuntimeKindIdV1::new(LOCAL_HMUX_RUNTIME_KIND)
                            .expect("static runtime kind is valid"),
                    ],
                }),
            },
            hmux_identity,
        }
    }
}

impl ExtensionImplementation for LocalHmuxRuntimeAdapter {
    fn descriptor(&self) -> &ExtensionDescriptorV1 {
        &self.descriptor
    }

    fn probe(&self, _context: ExtensionProbeContextV1) -> ExtensionProbeOutcomeV1 {
        ExtensionProbeOutcomeV1::Available
    }
}

impl RuntimeAdapterImplementation for LocalHmuxRuntimeAdapter {
    fn probe_session(
        &self,
        authority: AgentCheckpointBindingAuthorityV1,
    ) -> RuntimeAdapterFutureV1<Result<RuntimeSessionProbeReceiptV1, ExtensionFailureCodeV1>> {
        let hmux_identity = self.hmux_identity.clone();
        Box::pin(async move {
            let stop_fence = HmuxStopFence {
                runner_principal: authority.runner_principal,
                runner_instance: authority.runner_instance,
                channel_epoch: authority.channel_epoch,
                host_instance_id: authority.host_instance_id,
                terminal_epoch: authority.terminal_epoch,
            };
            query_hmux(
                &hmux_identity,
                &authority.binding.session_id,
                &authority.runtime_workspace_id,
                &stop_fence,
            )
            .await
            .map_err(|code| {
                ExtensionFailureCodeV1::new(code).unwrap_or_else(|_| {
                    ExtensionFailureCodeV1::new("runtime_session_probe_failed")
                        .expect("static failure code is valid")
                })
            })?;
            Ok(RuntimeSessionProbeReceiptV1 {
                runtime_kind_id: authority.binding.runtime_kind_id,
                session_id: authority.binding.session_id,
                workspace_id: authority.runtime_workspace_id,
            })
        })
    }
}

pub(crate) fn local_hmux_runtime_registry(
    hmux_identity: HmuxToolchainIdentity,
) -> RuntimeAdapterRegistry {
    let mut registry = RuntimeAdapterRegistry::default();
    let outcome = registry.register(
        Arc::new(LocalHmuxRuntimeAdapter::new(hmux_identity)),
        &HostCompatibilityV1::current(Vec::new(), Vec::new(), Vec::new()),
        BUNDLED_PROBE_TIMEOUT,
    );
    assert!(
        matches!(outcome, Ok(RegistrationOutcomeV1::Registered(_))),
        "bundled local Hmux runtime registration failed: {outcome:?}"
    );
    registry
}
