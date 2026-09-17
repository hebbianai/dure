use std::{
    collections::BTreeMap,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use dure_app::{
    AgentProviderContractV1, AgentProviderImplementation, AgentProviderPreflightPlanV1,
    AgentProviderRegistrationErrorV1, AgentProviderRegistry, AgentSpawnModelSelectionV1,
    ApiVersionRangeV1, CapabilityDeclarationV1, CompatibilityOutcomeV1,
    EXTENSION_DESCRIPTOR_SCHEMA_VERSION, ExtensionContractV1, ExtensionDescriptorV1,
    ExtensionFailureCodeV1, ExtensionIdV1, ExtensionImplementation, ExtensionProbeContextV1,
    ExtensionProbeOutcomeV1, HostCompatibilityV1, ProviderIdV1, ProviderPermissionModeV1,
    RegistrationOutcomeV1, RuntimeAdapterContractV1, RuntimeKindIdV1,
};

struct FixtureProvider {
    descriptor: ExtensionDescriptorV1,
    plans: BTreeMap<ProviderIdV1, AgentProviderPreflightPlanV1>,
    probe: ExtensionProbeOutcomeV1,
    probe_calls: Arc<AtomicUsize>,
}

impl ExtensionImplementation for FixtureProvider {
    fn descriptor(&self) -> &ExtensionDescriptorV1 {
        &self.descriptor
    }

    fn probe(&self, _context: ExtensionProbeContextV1) -> ExtensionProbeOutcomeV1 {
        self.probe_calls.fetch_add(1, Ordering::SeqCst);
        self.probe.clone()
    }
}

impl AgentProviderImplementation for FixtureProvider {
    fn preflight_plan(
        &self,
        provider_id: &ProviderIdV1,
    ) -> Result<AgentProviderPreflightPlanV1, ExtensionFailureCodeV1> {
        self.plans
            .get(provider_id)
            .cloned()
            .ok_or_else(|| ExtensionFailureCodeV1::new("preflight_plan_missing").unwrap())
    }
}

fn provider_id(value: &str) -> ProviderIdV1 {
    ProviderIdV1::new(value).unwrap()
}

fn descriptor(id: &str, provider: &str) -> ExtensionDescriptorV1 {
    ExtensionDescriptorV1 {
        schema_version: EXTENSION_DESCRIPTOR_SCHEMA_VERSION,
        id: ExtensionIdV1::new(id).unwrap(),
        display_name: id.to_owned(),
        api: ApiVersionRangeV1::current_and_previous(),
        capabilities: CapabilityDeclarationV1::default(),
        permissions: Vec::new(),
        extension: ExtensionContractV1::AgentProvider(AgentProviderContractV1 {
            provider_ids: vec![provider_id(provider)],
        }),
    }
}

fn fixture(id: &str, provider: &str, executable: &str) -> Arc<FixtureProvider> {
    Arc::new(FixtureProvider {
        descriptor: descriptor(id, provider),
        plans: BTreeMap::from([(
            provider_id(provider),
            AgentProviderPreflightPlanV1 {
                executable: executable.to_owned(),
            },
        )]),
        probe: ExtensionProbeOutcomeV1::Available,
        probe_calls: Arc::new(AtomicUsize::new(0)),
    })
}

fn host() -> HostCompatibilityV1 {
    HostCompatibilityV1::current(Vec::new(), Vec::new(), Vec::new())
}

#[test]
fn registers_and_resolves_a_provider_preflight_plan() {
    let mut registry = AgentProviderRegistry::default();
    assert!(matches!(
        registry
            .register(
                fixture("fixture.codex", "codex", "codex"),
                &host(),
                Duration::from_millis(50),
            )
            .unwrap(),
        RegistrationOutcomeV1::Registered(CompatibilityOutcomeV1::Supported { .. })
    ));
    assert_eq!(registry.extension_count(), 1);
    assert_eq!(registry.provider_count(), 1);
    assert_eq!(
        registry.preflight_plan(&provider_id("codex")).unwrap(),
        Some(AgentProviderPreflightPlanV1 {
            executable: "codex".to_owned(),
        })
    );
    assert_eq!(
        registry
            .launch_plan(
                &provider_id("codex"),
                &ProviderPermissionModeV1::Default,
                None,
                None,
                None,
            )
            .unwrap()
            .unwrap()
            .arguments,
        Vec::<String>::new()
    );
    assert_eq!(
        registry
            .launch_plan(
                &provider_id("codex"),
                &ProviderPermissionModeV1::SkipPermissions,
                None,
                None,
                None,
            )
            .unwrap_err()
            .code
            .as_str(),
        "permission_mode_unsupported"
    );
    assert_eq!(
        registry
            .launch_plan(
                &provider_id("codex"),
                &ProviderPermissionModeV1::Default,
                Some(&AgentSpawnModelSelectionV1::parse("opus").unwrap()),
                None,
                None,
            )
            .unwrap_err()
            .code
            .as_str(),
        "model_selection_unsupported"
    );
    assert_eq!(
        registry
            .launch_plan(
                &provider_id("codex"),
                &ProviderPermissionModeV1::Default,
                None,
                None,
                Some("conversation-1"),
            )
            .unwrap_err()
            .code
            .as_str(),
        "conversation_resume_unsupported"
    );
    assert_eq!(
        registry.preflight_plan(&provider_id("claude")).unwrap(),
        None
    );
}

#[test]
fn duplicate_provider_ownership_fails_before_probe() {
    let mut registry = AgentProviderRegistry::default();
    registry
        .register(
            fixture("fixture.first", "codex", "codex"),
            &host(),
            Duration::from_millis(50),
        )
        .unwrap();
    let duplicate = fixture("fixture.second", "codex", "codex-next");
    let probe_calls = Arc::clone(&duplicate.probe_calls);
    assert!(matches!(
        registry.register(duplicate, &host(), Duration::from_millis(50)),
        Err(AgentProviderRegistrationErrorV1::DuplicateProviderId { provider_id: duplicate_id, .. })
            if duplicate_id == provider_id("codex")
    ));
    assert_eq!(probe_calls.load(Ordering::SeqCst), 0);
    assert_eq!(registry.extension_count(), 1);
}

#[test]
fn wrong_family_fails_before_probe() {
    let mut wrong = fixture("fixture.runtime", "codex", "codex");
    Arc::get_mut(&mut wrong).unwrap().descriptor.extension =
        ExtensionContractV1::RuntimeAdapter(RuntimeAdapterContractV1 {
            runtime_kinds: vec![RuntimeKindIdV1::new("local").unwrap()],
        });
    let probe_calls = Arc::clone(&wrong.probe_calls);
    let mut registry = AgentProviderRegistry::default();
    assert!(matches!(
        registry.register(wrong, &host(), Duration::from_millis(50)),
        Err(AgentProviderRegistrationErrorV1::WrongExtensionFamily { .. })
    ));
    assert_eq!(probe_calls.load(Ordering::SeqCst), 0);
    assert_eq!(registry.extension_count(), 0);
}

#[test]
fn incompatible_or_failed_probe_never_populates_the_provider_index() {
    let mut incompatible = fixture("fixture.future", "future", "future");
    Arc::get_mut(&mut incompatible).unwrap().descriptor.api = ApiVersionRangeV1::new(3, 3);

    let mut failed = fixture("fixture.failed", "failed", "failed");
    Arc::get_mut(&mut failed).unwrap().probe = ExtensionProbeOutcomeV1::Unavailable {
        code: ExtensionFailureCodeV1::new("fixture_failed").unwrap(),
        retryable: true,
    };

    for implementation in [incompatible, failed] {
        let provider = match &implementation.descriptor.extension {
            ExtensionContractV1::AgentProvider(contract) => contract.provider_ids[0].clone(),
            _ => unreachable!(),
        };
        let mut registry = AgentProviderRegistry::default();
        assert!(matches!(
            registry
                .register(implementation, &host(), Duration::from_millis(50))
                .unwrap(),
            RegistrationOutcomeV1::Rejected(_)
        ));
        assert_eq!(registry.preflight_plan(&provider).unwrap(), None);
        assert_eq!(registry.extension_count(), 0);
    }
}
