use std::{
    future::Future,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    task::{Context, Poll, Waker},
    time::Duration,
};

use dure_app::{
    AGENT_CHECKPOINT_SCHEMA_VERSION_V1, AgentCheckpointBindingAuthorityV1, AgentIdV1,
    AgentProviderContractV1, ApiVersionRangeV1, CapabilityDeclarationV1, CompatibilityOutcomeV1,
    EXTENSION_DESCRIPTOR_SCHEMA_VERSION, ExtensionContractV1, ExtensionDescriptorV1,
    ExtensionFailureCodeV1, ExtensionIdV1, ExtensionImplementation, ExtensionProbeContextV1,
    ExtensionProbeOutcomeV1, HostCompatibilityV1, ProviderIdV1, RegistrationOutcomeV1,
    RuntimeAdapterContractV1, RuntimeAdapterFutureV1, RuntimeAdapterImplementation,
    RuntimeAdapterRegistrationErrorV1, RuntimeAdapterRegistry, RuntimeKindIdV1,
    RuntimeSessionProbeReceiptV1, SessionBindingRecordV1,
};

#[derive(Clone)]
enum FixtureOutcome {
    Available,
    Failed(ExtensionFailureCodeV1),
    Mismatched,
}

struct FixtureRuntime {
    descriptor: ExtensionDescriptorV1,
    outcome: FixtureOutcome,
    probe_calls: Arc<AtomicUsize>,
}

impl ExtensionImplementation for FixtureRuntime {
    fn descriptor(&self) -> &ExtensionDescriptorV1 {
        &self.descriptor
    }

    fn probe(&self, _context: ExtensionProbeContextV1) -> ExtensionProbeOutcomeV1 {
        self.probe_calls.fetch_add(1, Ordering::SeqCst);
        ExtensionProbeOutcomeV1::Available
    }
}

impl RuntimeAdapterImplementation for FixtureRuntime {
    fn probe_session(
        &self,
        authority: AgentCheckpointBindingAuthorityV1,
    ) -> RuntimeAdapterFutureV1<Result<RuntimeSessionProbeReceiptV1, ExtensionFailureCodeV1>> {
        let outcome = self.outcome.clone();
        Box::pin(async move {
            match outcome {
                FixtureOutcome::Available => Ok(RuntimeSessionProbeReceiptV1 {
                    runtime_kind_id: authority.binding.runtime_kind_id,
                    session_id: authority.binding.session_id,
                    workspace_id: authority.runtime_workspace_id,
                }),
                FixtureOutcome::Failed(code) => Err(code),
                FixtureOutcome::Mismatched => Ok(RuntimeSessionProbeReceiptV1 {
                    runtime_kind_id: authority.binding.runtime_kind_id,
                    session_id: "different-session".into(),
                    workspace_id: authority.runtime_workspace_id,
                }),
            }
        })
    }
}

fn runtime_kind(value: &str) -> RuntimeKindIdV1 {
    RuntimeKindIdV1::new(value).unwrap()
}

fn descriptor(id: &str, runtime: &str) -> ExtensionDescriptorV1 {
    ExtensionDescriptorV1 {
        schema_version: EXTENSION_DESCRIPTOR_SCHEMA_VERSION,
        id: ExtensionIdV1::new(id).unwrap(),
        display_name: id.to_owned(),
        api: ApiVersionRangeV1::current_and_previous(),
        capabilities: CapabilityDeclarationV1::default(),
        permissions: Vec::new(),
        extension: ExtensionContractV1::RuntimeAdapter(RuntimeAdapterContractV1 {
            runtime_kinds: vec![runtime_kind(runtime)],
        }),
    }
}

fn fixture(id: &str, runtime: &str, outcome: FixtureOutcome) -> Arc<FixtureRuntime> {
    Arc::new(FixtureRuntime {
        descriptor: descriptor(id, runtime),
        outcome,
        probe_calls: Arc::new(AtomicUsize::new(0)),
    })
}

fn authority(runtime: &str) -> AgentCheckpointBindingAuthorityV1 {
    AgentCheckpointBindingAuthorityV1 {
        schema_version: AGENT_CHECKPOINT_SCHEMA_VERSION_V1,
        binding: SessionBindingRecordV1 {
            agent_id: AgentIdV1::new("agent-1").unwrap(),
            runtime_kind_id: runtime_kind(runtime),
            session_id: "session-1".into(),
            provider_conversation_id: None,
            credential_reference_id: None,
            binding_generation: 1,
            bound_at_ms: 1,
        },
        runtime_workspace_id: "workspace-1".into(),
        runner_principal: "runner-1".into(),
        runner_instance: "instance-1".into(),
        channel_epoch: "channel-1".into(),
        host_instance_id: "host-1".into(),
        terminal_epoch: "terminal-1".into(),
        updated_at_ms: 1,
    }
}

fn host() -> HostCompatibilityV1 {
    HostCompatibilityV1::current(Vec::new(), Vec::new(), Vec::new())
}

fn block_on<F: Future>(future: F) -> F::Output {
    let mut context = Context::from_waker(Waker::noop());
    let mut future = std::pin::pin!(future);
    loop {
        match future.as_mut().poll(&mut context) {
            Poll::Ready(output) => return output,
            Poll::Pending => std::thread::yield_now(),
        }
    }
}

#[test]
fn registers_and_routes_an_exact_session_probe() {
    let mut registry = RuntimeAdapterRegistry::default();
    assert!(matches!(
        registry
            .register(
                fixture("fixture.local", "runtime.hmux", FixtureOutcome::Available),
                &host(),
                Duration::from_millis(50),
            )
            .unwrap(),
        RegistrationOutcomeV1::Registered(CompatibilityOutcomeV1::Supported { .. })
    ));
    assert_eq!(registry.extension_count(), 1);
    assert_eq!(registry.runtime_count(), 1);
    assert_eq!(
        block_on(registry.probe_session(authority("runtime.hmux"))).unwrap(),
        Some(RuntimeSessionProbeReceiptV1 {
            runtime_kind_id: runtime_kind("runtime.hmux"),
            session_id: "session-1".into(),
            workspace_id: "workspace-1".into(),
        })
    );
    assert_eq!(
        block_on(registry.probe_session(authority("runtime.unknown"))).unwrap(),
        None
    );
}

#[test]
fn duplicate_runtime_ownership_fails_before_probe() {
    let mut registry = RuntimeAdapterRegistry::default();
    registry
        .register(
            fixture("fixture.first", "runtime.hmux", FixtureOutcome::Available),
            &host(),
            Duration::from_millis(50),
        )
        .unwrap();
    let duplicate = fixture("fixture.second", "runtime.hmux", FixtureOutcome::Available);
    let probe_calls = Arc::clone(&duplicate.probe_calls);
    assert!(matches!(
        registry.register(duplicate, &host(), Duration::from_millis(50)),
        Err(RuntimeAdapterRegistrationErrorV1::DuplicateRuntimeKind {
            runtime_kind_id,
            ..
        }) if runtime_kind_id == runtime_kind("runtime.hmux")
    ));
    assert_eq!(probe_calls.load(Ordering::SeqCst), 0);
}

#[test]
fn wrong_family_fails_before_probe() {
    let mut wrong = fixture(
        "fixture.provider",
        "runtime.hmux",
        FixtureOutcome::Available,
    );
    Arc::get_mut(&mut wrong).unwrap().descriptor.extension =
        ExtensionContractV1::AgentProvider(AgentProviderContractV1 {
            provider_ids: vec![ProviderIdV1::new("codex").unwrap()],
        });
    let probe_calls = Arc::clone(&wrong.probe_calls);
    let mut registry = RuntimeAdapterRegistry::default();
    assert!(matches!(
        registry.register(wrong, &host(), Duration::from_millis(50)),
        Err(RuntimeAdapterRegistrationErrorV1::WrongExtensionFamily { .. })
    ));
    assert_eq!(probe_calls.load(Ordering::SeqCst), 0);
    assert_eq!(registry.extension_count(), 0);
}

#[test]
fn in_memory_fault_is_isolated_as_a_typed_operation_error() {
    let mut registry = RuntimeAdapterRegistry::default();
    registry
        .register(
            fixture(
                "fixture.fault",
                "runtime.fault",
                FixtureOutcome::Failed(
                    ExtensionFailureCodeV1::new("runtime_fault_injected").unwrap(),
                ),
            ),
            &host(),
            Duration::from_millis(50),
        )
        .unwrap();
    let error = block_on(registry.probe_session(authority("runtime.fault"))).unwrap_err();
    assert_eq!(error.extension_id.as_str(), "fixture.fault");
    assert_eq!(error.runtime_kind_id, runtime_kind("runtime.fault"));
    assert_eq!(error.code.as_str(), "runtime_fault_injected");
}

#[test]
fn adapter_cannot_replace_the_exact_probe_identity() {
    let mut registry = RuntimeAdapterRegistry::default();
    registry
        .register(
            fixture(
                "fixture.mismatch",
                "runtime.mismatch",
                FixtureOutcome::Mismatched,
            ),
            &host(),
            Duration::from_millis(50),
        )
        .unwrap();
    let error = block_on(registry.probe_session(authority("runtime.mismatch"))).unwrap_err();
    assert_eq!(error.code.as_str(), "session_probe_receipt_mismatch");
}

#[test]
fn invalid_authority_fails_before_runtime_code() {
    let mut registry = RuntimeAdapterRegistry::default();
    registry
        .register(
            fixture(
                "fixture.invalid",
                "runtime.invalid",
                FixtureOutcome::Available,
            ),
            &host(),
            Duration::from_millis(50),
        )
        .unwrap();
    let mut invalid = authority("runtime.invalid");
    invalid.terminal_epoch.clear();
    let error = block_on(registry.probe_session(invalid)).unwrap_err();
    assert_eq!(error.code.as_str(), "session_probe_request_invalid");
}
