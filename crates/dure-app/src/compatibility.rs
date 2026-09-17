use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{
    ApiVersionRangeV1, CapabilityIdV1, ExtensionDescriptorV1, ExtensionFailureCodeV1,
    PermissionIdV1,
};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
pub struct HostCompatibilityV1 {
    pub api: ApiVersionRangeV1,
    #[serde(default)]
    pub provided_capabilities: Vec<CapabilityIdV1>,
    #[serde(default)]
    pub required_extension_capabilities: Vec<CapabilityIdV1>,
    #[serde(default)]
    pub granted_permissions: Vec<PermissionIdV1>,
}

impl HostCompatibilityV1 {
    pub fn current(
        provided_capabilities: Vec<CapabilityIdV1>,
        required_extension_capabilities: Vec<CapabilityIdV1>,
        granted_permissions: Vec<PermissionIdV1>,
    ) -> Self {
        Self {
            api: ApiVersionRangeV1::current_and_previous(),
            provided_capabilities,
            required_extension_capabilities,
            granted_permissions,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ExtensionAvailabilityV1 {
    Available,
    Unavailable {
        reason: UnavailableReasonV1,
        retryable: bool,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum UnavailableReasonV1 {
    NotInstalled,
    Disabled,
    ProbeTimedOut,
    ProbeFailed { code: ExtensionFailureCodeV1 },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
pub struct MissingRequiredCapabilitiesV1 {
    #[serde(default)]
    pub missing_from_host: Vec<CapabilityIdV1>,
    #[serde(default)]
    pub missing_from_extension: Vec<CapabilityIdV1>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum CompatibilityOutcomeV1 {
    Supported {
        negotiated_api_version: u16,
        #[serde(default)]
        enabled_optional_capabilities: Vec<CapabilityIdV1>,
    },
    Unsupported {
        missing_required_capabilities: MissingRequiredCapabilitiesV1,
    },
    IncompatibleApiVersion {
        host: ApiVersionRangeV1,
        extension: ApiVersionRangeV1,
    },
    PermissionRequired {
        missing_permissions: Vec<PermissionIdV1>,
    },
    Unavailable {
        reason: UnavailableReasonV1,
        retryable: bool,
    },
}

impl CompatibilityOutcomeV1 {
    pub const fn is_supported(&self) -> bool {
        matches!(self, Self::Supported { .. })
    }
}

pub fn evaluate_compatibility(
    descriptor: &ExtensionDescriptorV1,
    host: &HostCompatibilityV1,
    availability: ExtensionAvailabilityV1,
) -> CompatibilityOutcomeV1 {
    let Some(negotiated_api_version) = descriptor.api.highest_common(host.api) else {
        return CompatibilityOutcomeV1::IncompatibleApiVersion {
            host: host.api,
            extension: descriptor.api,
        };
    };

    let host_provided: BTreeSet<_> = host.provided_capabilities.iter().cloned().collect();
    let extension_provided: BTreeSet<_> =
        descriptor.capabilities.provided.iter().cloned().collect();
    let missing_from_host = descriptor
        .capabilities
        .required
        .iter()
        .filter(|capability| !host_provided.contains(*capability))
        .cloned()
        .collect::<Vec<_>>();
    let missing_from_extension = host
        .required_extension_capabilities
        .iter()
        .filter(|capability| !extension_provided.contains(*capability))
        .cloned()
        .collect::<Vec<_>>();
    if !missing_from_host.is_empty() || !missing_from_extension.is_empty() {
        return CompatibilityOutcomeV1::Unsupported {
            missing_required_capabilities: MissingRequiredCapabilitiesV1 {
                missing_from_host,
                missing_from_extension,
            },
        };
    }

    let granted_permissions: BTreeSet<_> = host.granted_permissions.iter().cloned().collect();
    let missing_permissions = descriptor
        .permissions
        .iter()
        .filter(|permission| !granted_permissions.contains(*permission))
        .cloned()
        .collect::<Vec<_>>();
    if !missing_permissions.is_empty() {
        return CompatibilityOutcomeV1::PermissionRequired {
            missing_permissions,
        };
    }

    if let ExtensionAvailabilityV1::Unavailable { reason, retryable } = availability {
        return CompatibilityOutcomeV1::Unavailable { reason, retryable };
    }

    let enabled_optional_capabilities = descriptor
        .capabilities
        .optional
        .iter()
        .filter(|capability| host_provided.contains(*capability))
        .cloned()
        .collect();
    CompatibilityOutcomeV1::Supported {
        negotiated_api_version,
        enabled_optional_capabilities,
    }
}
