use std::{sync::Arc, time::Duration};

use dure_app::{
    AgentProviderContractV1, ApiVersionRangeV1, CapabilityDeclarationV1, CapabilityIdV1,
    CompatibilityOutcomeV1, EXTENSION_DESCRIPTOR_SCHEMA_VERSION, ExtensionAvailabilityV1,
    ExtensionContractV1, ExtensionDescriptorV1, ExtensionFailureCodeV1, ExtensionIdV1,
    ExtensionImplementation, ExtensionProbeContextV1, ExtensionProbeOutcomeV1, ExtensionRegistry,
    FileViewProviderContractV1, HostCompatibilityV1, PermissionIdV1, ProviderIdV1,
    RegistrationOutcomeV1, RuntimeAdapterContractV1, RuntimeKindIdV1, UnavailableReasonV1,
    WorkspaceToolKindIdV1, WorkspaceToolProviderContractV1, evaluate_compatibility,
};

struct FixtureExtension {
    descriptor: ExtensionDescriptorV1,
    probe: ExtensionProbeOutcomeV1,
    panic_on_probe: bool,
}

impl ExtensionImplementation for FixtureExtension {
    fn descriptor(&self) -> &ExtensionDescriptorV1 {
        &self.descriptor
    }

    fn probe(&self, _context: ExtensionProbeContextV1) -> ExtensionProbeOutcomeV1 {
        assert!(!self.panic_on_probe, "fixture probe failure");
        self.probe.clone()
    }
}

fn id(value: &str) -> ExtensionIdV1 {
    ExtensionIdV1::new(value).unwrap()
}

fn capability(value: &str) -> CapabilityIdV1 {
    CapabilityIdV1::new(value).unwrap()
}

fn permission(value: &str) -> PermissionIdV1 {
    PermissionIdV1::new(value).unwrap()
}

fn failure_code(value: &str) -> ExtensionFailureCodeV1 {
    ExtensionFailureCodeV1::new(value).unwrap()
}

fn provider_id(value: &str) -> ProviderIdV1 {
    ProviderIdV1::new(value).unwrap()
}

fn runtime_kind(value: &str) -> RuntimeKindIdV1 {
    RuntimeKindIdV1::new(value).unwrap()
}

fn tool_kind(value: &str) -> WorkspaceToolKindIdV1 {
    WorkspaceToolKindIdV1::new(value).unwrap()
}

fn descriptor(
    extension_id: &str,
    api: ApiVersionRangeV1,
    extension: ExtensionContractV1,
) -> ExtensionDescriptorV1 {
    ExtensionDescriptorV1 {
        schema_version: EXTENSION_DESCRIPTOR_SCHEMA_VERSION,
        id: id(extension_id),
        display_name: extension_id.to_owned(),
        api,
        capabilities: CapabilityDeclarationV1::default(),
        permissions: Vec::new(),
        extension,
    }
}

fn implementation(descriptor: ExtensionDescriptorV1) -> Arc<FixtureExtension> {
    Arc::new(FixtureExtension {
        descriptor,
        probe: ExtensionProbeOutcomeV1::Available,
        panic_on_probe: false,
    })
}

fn host() -> HostCompatibilityV1 {
    HostCompatibilityV1::current(Vec::new(), Vec::new(), Vec::new())
}

#[test]
fn registers_each_contract_family_without_core_switches() {
    let fixtures = [
        descriptor(
            "fixture.agent",
            ApiVersionRangeV1::new(1, 2),
            ExtensionContractV1::AgentProvider(AgentProviderContractV1 {
                provider_ids: vec![provider_id("fixture.provider")],
            }),
        ),
        descriptor(
            "fixture.runtime",
            ApiVersionRangeV1::new(1, 2),
            ExtensionContractV1::RuntimeAdapter(RuntimeAdapterContractV1 {
                runtime_kinds: vec![runtime_kind("fixture.memory")],
            }),
        ),
        descriptor(
            "fixture.formatter",
            ApiVersionRangeV1::new(1, 2),
            ExtensionContractV1::WorkspaceToolProvider(WorkspaceToolProviderContractV1 {
                tool_kinds: vec![tool_kind("formatter")],
                languages: vec!["text".to_owned()],
            }),
        ),
        descriptor(
            "fixture.text-view",
            ApiVersionRangeV1::new(1, 2),
            ExtensionContractV1::FileViewProvider(FileViewProviderContractV1 {
                media_types: vec!["text/plain".to_owned()],
                file_extensions: vec!["txt".to_owned()],
            }),
        ),
    ];
    let mut registry = ExtensionRegistry::default();
    for fixture in fixtures {
        assert!(matches!(
            registry.register(implementation(fixture), &host(), Duration::from_millis(50)),
            RegistrationOutcomeV1::Registered(CompatibilityOutcomeV1::Supported {
                negotiated_api_version: 2,
                ..
            })
        ));
    }
    assert_eq!(registry.len(), 4);
}

#[test]
fn registers_a_future_custom_workspace_tool_without_a_core_enum_change() {
    let custom_kind = tool_kind("semantic-indexer");
    let fixture = descriptor(
        "fixture.semantic-indexer",
        ApiVersionRangeV1::new(1, 2),
        ExtensionContractV1::WorkspaceToolProvider(WorkspaceToolProviderContractV1 {
            tool_kinds: vec![custom_kind.clone()],
            languages: vec!["future-language".to_owned()],
        }),
    );
    let mut registry = ExtensionRegistry::default();
    assert!(matches!(
        registry.register(implementation(fixture), &host(), Duration::from_millis(50)),
        RegistrationOutcomeV1::Registered(CompatibilityOutcomeV1::Supported { .. })
    ));
    let registered = registry.get(&id("fixture.semantic-indexer")).unwrap();
    assert!(matches!(
        &registered.descriptor().extension,
        ExtensionContractV1::WorkspaceToolProvider(contract)
            if contract.tool_kinds == vec![custom_kind]
    ));
}

#[test]
fn supports_previous_and_current_api_but_rejects_future_only_before_registration() {
    for (api, expected_version) in [
        (ApiVersionRangeV1::new(1, 1), Some(1)),
        (ApiVersionRangeV1::new(1, 2), Some(2)),
        (ApiVersionRangeV1::new(3, 3), None),
    ] {
        let mut registry = ExtensionRegistry::default();
        let descriptor = descriptor(
            "fixture.provider",
            api,
            ExtensionContractV1::AgentProvider(AgentProviderContractV1 {
                provider_ids: vec![provider_id("fixture.provider")],
            }),
        );
        let fixture = if expected_version.is_none() {
            Arc::new(FixtureExtension {
                descriptor,
                probe: ExtensionProbeOutcomeV1::Available,
                panic_on_probe: true,
            })
        } else {
            implementation(descriptor)
        };
        let outcome = registry.register(fixture, &host(), Duration::from_millis(50));
        match expected_version {
            Some(version) => assert!(matches!(
                outcome,
                RegistrationOutcomeV1::Registered(CompatibilityOutcomeV1::Supported {
                    negotiated_api_version,
                    ..
                }) if negotiated_api_version == version
            )),
            None => {
                assert!(matches!(
                    outcome,
                    RegistrationOutcomeV1::Rejected(
                        CompatibilityOutcomeV1::IncompatibleApiVersion { .. }
                    )
                ));
                assert!(registry.is_empty());
            }
        }
    }
}

#[test]
fn future_major_precedes_unavailable_in_the_public_compatibility_evaluator() {
    let future = descriptor(
        "fixture.future-unavailable",
        ApiVersionRangeV1::new(3, 3),
        ExtensionContractV1::AgentProvider(AgentProviderContractV1 {
            provider_ids: vec![provider_id("fixture.future")],
        }),
    );
    assert!(matches!(
        evaluate_compatibility(
            &future,
            &host(),
            ExtensionAvailabilityV1::Unavailable {
                reason: UnavailableReasonV1::Disabled,
                retryable: false,
            },
        ),
        CompatibilityOutcomeV1::IncompatibleApiVersion { .. }
    ));
}

#[test]
fn ignores_unknown_optional_capability_but_fails_unknown_required_capability() {
    let unknown = capability("future.capability");
    let mut optional = descriptor(
        "fixture.optional",
        ApiVersionRangeV1::new(1, 2),
        ExtensionContractV1::AgentProvider(AgentProviderContractV1 {
            provider_ids: vec![provider_id("fixture.optional")],
        }),
    );
    optional.capabilities.optional.push(unknown.clone());

    let mut registry = ExtensionRegistry::default();
    assert!(matches!(
        registry.register(
            implementation(optional),
            &host(),
            Duration::from_millis(50)
        ),
        RegistrationOutcomeV1::Registered(CompatibilityOutcomeV1::Supported {
            enabled_optional_capabilities,
            ..
        }) if enabled_optional_capabilities.is_empty()
    ));

    let mut required = descriptor(
        "fixture.required",
        ApiVersionRangeV1::new(1, 2),
        ExtensionContractV1::AgentProvider(AgentProviderContractV1 {
            provider_ids: vec![provider_id("fixture.required")],
        }),
    );
    required.capabilities.required.push(unknown.clone());
    let mut registry = ExtensionRegistry::default();
    assert!(matches!(
        registry.register(
            implementation(required),
            &host(),
            Duration::from_millis(50)
        ),
        RegistrationOutcomeV1::Rejected(CompatibilityOutcomeV1::Unsupported {
            missing_required_capabilities,
        }) if missing_required_capabilities.missing_from_host == vec![unknown]
    ));
    assert!(registry.is_empty());
}

#[test]
fn rejects_missing_permission_before_registration() {
    let mut fixture = descriptor(
        "fixture.permission",
        ApiVersionRangeV1::new(1, 2),
        ExtensionContractV1::RuntimeAdapter(RuntimeAdapterContractV1 {
            runtime_kinds: vec![runtime_kind("fixture.memory")],
        }),
    );
    fixture.permissions.push(permission("workspace.write"));

    let mut registry = ExtensionRegistry::default();
    assert!(matches!(
        registry.register(
            implementation(fixture),
            &host(),
            Duration::from_millis(50)
        ),
        RegistrationOutcomeV1::Rejected(CompatibilityOutcomeV1::PermissionRequired {
            missing_permissions,
        }) if missing_permissions == vec![permission("workspace.write")]
    ));
    assert!(registry.is_empty());
}

#[test]
fn isolates_reported_timeout_failure_and_probe_panic() {
    let fixture = descriptor(
        "fixture.failure",
        ApiVersionRangeV1::new(1, 2),
        ExtensionContractV1::RuntimeAdapter(RuntimeAdapterContractV1 {
            runtime_kinds: vec![runtime_kind("fixture.memory")],
        }),
    );
    for implementation in [
        Arc::new(FixtureExtension {
            descriptor: fixture.clone(),
            probe: ExtensionProbeOutcomeV1::TimedOut,
            panic_on_probe: false,
        }),
        Arc::new(FixtureExtension {
            descriptor: fixture.clone(),
            probe: ExtensionProbeOutcomeV1::Unavailable {
                code: failure_code("fixture_failed"),
                retryable: true,
            },
            panic_on_probe: false,
        }),
        Arc::new(FixtureExtension {
            descriptor: fixture.clone(),
            probe: ExtensionProbeOutcomeV1::Available,
            panic_on_probe: true,
        }),
    ] {
        let mut registry = ExtensionRegistry::default();
        assert!(matches!(
            registry.register(implementation, &host(), Duration::from_millis(50)),
            RegistrationOutcomeV1::Rejected(CompatibilityOutcomeV1::Unavailable { .. })
        ));
        assert!(registry.is_empty());
    }
}

#[test]
fn serde_round_trips_tagged_unions_optional_fields_and_error_shapes() {
    let descriptor = descriptor(
        "fixture.serde",
        ApiVersionRangeV1::new(1, 2),
        ExtensionContractV1::WorkspaceToolProvider(WorkspaceToolProviderContractV1 {
            tool_kinds: vec![tool_kind("formatter")],
            languages: Vec::new(),
        }),
    );
    let json = serde_json::to_value(&descriptor).unwrap();
    assert_eq!(json["extension"]["kind"], "workspace_tool_provider");
    assert_eq!(
        serde_json::from_value::<ExtensionDescriptorV1>(json).unwrap(),
        descriptor
    );

    let error = CompatibilityOutcomeV1::PermissionRequired {
        missing_permissions: vec![permission("workspace.write")],
    };
    let error_json = serde_json::to_value(&error).unwrap();
    assert_eq!(error_json["status"], "permission_required");
    assert_eq!(
        serde_json::from_value::<CompatibilityOutcomeV1>(error_json).unwrap(),
        error
    );

    let with_unknown_optional_field = serde_json::json!({
        "schema_version": 1,
        "id": "fixture.forward-compatible",
        "display_name": "Forward compatible",
        "api": { "min_inclusive": 1, "max_inclusive": 2 },
        "capabilities": {},
        "permissions": [],
        "extension": {
            "kind": "file_view_provider",
            "contract": {
                "media_types": ["text/plain"],
                "file_extensions": [],
                "future_optional_field": true
            }
        },
        "future_optional_field": { "ignored": true }
    });
    assert!(serde_json::from_value::<ExtensionDescriptorV1>(with_unknown_optional_field).is_ok());
}

#[test]
fn checked_typescript_artifact_matches_rust_dtos() {
    let generated = dure_app::typescript_contracts();
    let checked = include_str!("../../../src/contracts/generated/extensionContracts.ts");
    assert_eq!(generated, checked);
}
