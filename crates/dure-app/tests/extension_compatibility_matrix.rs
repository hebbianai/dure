use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use dure_app::{
    ApiVersionRangeV1, CURRENT_EXTENSION_API_VERSION, CompatibilityOutcomeV1,
    ExtensionDescriptorV1, ExtensionImplementation, ExtensionProbeContextV1,
    ExtensionProbeOutcomeV1, ExtensionRegistry, HostCompatibilityV1,
    PREVIOUS_EXTENSION_API_VERSION, RegistrationOutcomeV1,
};
use serde::Deserialize;

const _: () = assert!(
    PREVIOUS_EXTENSION_API_VERSION < CURRENT_EXTENSION_API_VERSION,
    "extension compatibility constants must describe an ordered window"
);

#[derive(Debug, Deserialize)]
struct CompatibilityManifest {
    schema_version: u16,
    host: HostCompatibilityV1,
    cases: Vec<CompatibilityCase>,
}

#[derive(Debug, Deserialize)]
struct CompatibilityCase {
    name: String,
    api_generation: ApiGeneration,
    descriptor: ExtensionDescriptorV1,
    expected: ExpectedOutcome,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
enum ApiGeneration {
    Current,
    Previous,
    FutureMajor,
}

#[derive(Debug, Deserialize)]
struct ExpectedOutcome {
    status: ExpectedStatus,
    negotiated_api_version: Option<u16>,
    probe_calls: usize,
    state_mutations: usize,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
enum ExpectedStatus {
    Supported,
    IncompatibleApiVersion,
}

struct ManifestExtension {
    descriptor: ExtensionDescriptorV1,
    probe_calls: Arc<AtomicUsize>,
    state_mutations: Arc<AtomicUsize>,
}

impl ExtensionImplementation for ManifestExtension {
    fn descriptor(&self) -> &ExtensionDescriptorV1 {
        &self.descriptor
    }

    fn probe(&self, _context: ExtensionProbeContextV1) -> ExtensionProbeOutcomeV1 {
        self.probe_calls.fetch_add(1, Ordering::SeqCst);
        self.state_mutations.fetch_add(1, Ordering::SeqCst);
        ExtensionProbeOutcomeV1::Available
    }
}

#[test]
fn manifest_driven_matrix_rejects_future_before_probe_or_state_mutation() {
    let manifest: CompatibilityManifest =
        serde_json::from_str(include_str!("fixtures/extension-compatibility-matrix.json"))
            .expect("compatibility fixture manifest must deserialize");
    assert_eq!(manifest.schema_version, 1);
    assert_eq!(
        manifest.host.api,
        ApiVersionRangeV1::current_and_previous(),
        "manifest host range drifted from the application compatibility policy"
    );

    let mut saw_current = false;
    let mut saw_previous = false;
    let mut saw_future_major = false;

    for case in manifest.cases {
        match case.api_generation {
            ApiGeneration::Current => {
                assert!(!saw_current, "manifest contains duplicate current cases");
                saw_current = true;
                assert_eq!(
                    case.descriptor.api,
                    ApiVersionRangeV1::new(
                        CURRENT_EXTENSION_API_VERSION,
                        CURRENT_EXTENSION_API_VERSION,
                    ),
                    "{} drifted from CURRENT_EXTENSION_API_VERSION",
                    case.name
                );
                assert_eq!(
                    case.expected.negotiated_api_version,
                    Some(CURRENT_EXTENSION_API_VERSION),
                    "{} expected current negotiated version drifted",
                    case.name
                );
            }
            ApiGeneration::Previous => {
                assert!(!saw_previous, "manifest contains duplicate previous cases");
                saw_previous = true;
                assert_eq!(
                    case.descriptor.api,
                    ApiVersionRangeV1::new(
                        PREVIOUS_EXTENSION_API_VERSION,
                        PREVIOUS_EXTENSION_API_VERSION,
                    ),
                    "{} drifted from PREVIOUS_EXTENSION_API_VERSION",
                    case.name
                );
                assert_eq!(
                    case.expected.negotiated_api_version,
                    Some(PREVIOUS_EXTENSION_API_VERSION),
                    "{} expected previous negotiated version drifted",
                    case.name
                );
            }
            ApiGeneration::FutureMajor => {
                assert!(
                    !saw_future_major,
                    "manifest contains duplicate future-major cases"
                );
                saw_future_major = true;
                assert!(
                    case.descriptor.api.min_inclusive > CURRENT_EXTENSION_API_VERSION,
                    "{} is not newer than CURRENT_EXTENSION_API_VERSION",
                    case.name
                );
                assert_eq!(
                    case.expected.negotiated_api_version, None,
                    "{} must not negotiate a future-major API",
                    case.name
                );
            }
        }
        case.descriptor
            .validate()
            .unwrap_or_else(|error| panic!("{} descriptor is invalid: {error}", case.name));
        let probe_calls = Arc::new(AtomicUsize::new(0));
        let state_mutations = Arc::new(AtomicUsize::new(0));
        let implementation = Arc::new(ManifestExtension {
            descriptor: case.descriptor,
            probe_calls: Arc::clone(&probe_calls),
            state_mutations: Arc::clone(&state_mutations),
        });
        let mut registry = ExtensionRegistry::default();
        let outcome = registry.register(implementation, &manifest.host, Duration::from_millis(50));

        match case.expected.status {
            ExpectedStatus::Supported => {
                assert!(matches!(
                    outcome,
                    RegistrationOutcomeV1::Registered(
                        CompatibilityOutcomeV1::Supported {
                            negotiated_api_version,
                            ..
                        }
                    ) if Some(negotiated_api_version)
                        == case.expected.negotiated_api_version
                ));
                assert_eq!(registry.len(), 1, "{} was not registered", case.name);
            }
            ExpectedStatus::IncompatibleApiVersion => {
                assert!(matches!(
                    outcome,
                    RegistrationOutcomeV1::Rejected(
                        CompatibilityOutcomeV1::IncompatibleApiVersion { .. }
                    )
                ));
                assert!(
                    registry.is_empty(),
                    "{} mutated the registry before rejection",
                    case.name
                );
            }
        }
        assert_eq!(
            probe_calls.load(Ordering::SeqCst),
            case.expected.probe_calls,
            "{} probe count",
            case.name
        );
        assert_eq!(
            state_mutations.load(Ordering::SeqCst),
            case.expected.state_mutations,
            "{} extension-owned state mutation count",
            case.name
        );
    }
    assert!(
        saw_current && saw_previous && saw_future_major,
        "manifest must contain exactly one current, previous, and future-major case"
    );
}
