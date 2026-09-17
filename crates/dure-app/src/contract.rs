use std::{collections::BTreeSet, error::Error, fmt};

use serde::{Deserialize, Deserializer, Serialize};
use ts_rs::TS;

pub const EXTENSION_DESCRIPTOR_SCHEMA_VERSION: u16 = 1;
pub const PREVIOUS_EXTENSION_API_VERSION: u16 = 1;
pub const CURRENT_EXTENSION_API_VERSION: u16 = 2;

macro_rules! stable_id {
    ($name:ident) => {
        #[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, TS)]
        #[ts(type = "string")]
        pub struct $name(String);

        impl $name {
            pub fn new(value: impl Into<String>) -> Result<Self, StableIdError> {
                let value = value.into();
                validate_stable_id(&value)?;
                Ok(Self(value))
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
            where
                D: Deserializer<'de>,
            {
                let value = String::deserialize(deserializer)?;
                Self::new(value).map_err(serde::de::Error::custom)
            }
        }
    };
}

stable_id!(ExtensionIdV1);
stable_id!(CapabilityIdV1);
stable_id!(PermissionIdV1);
stable_id!(ExtensionFailureCodeV1);
stable_id!(ProviderIdV1);
stable_id!(RuntimeKindIdV1);
stable_id!(WorkspaceToolKindIdV1);

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StableIdError {
    value: String,
    reason: &'static str,
}

impl fmt::Display for StableIdError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "invalid stable id {:?}: {}",
            self.value, self.reason
        )
    }
}

impl Error for StableIdError {}

pub(crate) fn validate_stable_id(value: &str) -> Result<(), StableIdError> {
    let invalid = |reason| StableIdError {
        value: value.to_owned(),
        reason,
    };
    if value.is_empty() {
        return Err(invalid("must not be empty"));
    }
    if value.len() > 128 {
        return Err(invalid("must be at most 128 bytes"));
    }
    if value.trim() != value {
        return Err(invalid("must not contain surrounding whitespace"));
    }

    let mut previous_separator = false;
    for (index, byte) in value.bytes().enumerate() {
        let separator = matches!(byte, b'.' | b'-' | b'_');
        let valid = byte.is_ascii_lowercase() || byte.is_ascii_digit() || separator;
        if !valid {
            return Err(invalid(
                "must contain only lowercase ASCII letters, digits, '.', '-' or '_'",
            ));
        }
        if index == 0 && !byte.is_ascii_lowercase() {
            return Err(invalid("must start with a lowercase ASCII letter"));
        }
        if separator && previous_separator {
            return Err(invalid("must not contain adjacent separators"));
        }
        previous_separator = separator;
    }
    if previous_separator {
        return Err(invalid("must not end with a separator"));
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize, TS)]
pub struct ApiVersionRangeV1 {
    pub min_inclusive: u16,
    pub max_inclusive: u16,
}

impl ApiVersionRangeV1 {
    pub const fn new(min_inclusive: u16, max_inclusive: u16) -> Self {
        Self {
            min_inclusive,
            max_inclusive,
        }
    }

    pub const fn current_and_previous() -> Self {
        Self::new(
            PREVIOUS_EXTENSION_API_VERSION,
            CURRENT_EXTENSION_API_VERSION,
        )
    }

    pub const fn is_valid(self) -> bool {
        self.min_inclusive > 0 && self.min_inclusive <= self.max_inclusive
    }

    pub const fn highest_common(self, other: Self) -> Option<u16> {
        let lowest_max = if self.max_inclusive < other.max_inclusive {
            self.max_inclusive
        } else {
            other.max_inclusive
        };
        let highest_min = if self.min_inclusive > other.min_inclusive {
            self.min_inclusive
        } else {
            other.min_inclusive
        };
        if highest_min <= lowest_max {
            Some(lowest_max)
        } else {
            None
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize, TS)]
pub struct CapabilityDeclarationV1 {
    #[serde(default)]
    pub provided: Vec<CapabilityIdV1>,
    #[serde(default)]
    pub required: Vec<CapabilityIdV1>,
    #[serde(default)]
    pub optional: Vec<CapabilityIdV1>,
}

impl CapabilityDeclarationV1 {
    pub fn validate(&self) -> Result<(), DescriptorValidationError> {
        reject_duplicates("provided capabilities", &self.provided)?;
        reject_duplicates("required capabilities", &self.required)?;
        reject_duplicates("optional capabilities", &self.optional)?;

        let required: BTreeSet<_> = self.required.iter().collect();
        let optional: BTreeSet<_> = self.optional.iter().collect();
        if let Some(overlap) = required.intersection(&optional).next() {
            return Err(DescriptorValidationError::new(format!(
                "capability {} cannot be both required and optional",
                overlap.as_str()
            )));
        }
        Ok(())
    }
}

fn reject_duplicates<T>(label: &str, values: &[T]) -> Result<(), DescriptorValidationError>
where
    T: Ord + fmt::Debug,
{
    let mut unique = BTreeSet::new();
    for value in values {
        if !unique.insert(value) {
            return Err(DescriptorValidationError::new(format!(
                "{label} contains duplicate {value:?}"
            )));
        }
    }
    Ok(())
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
pub struct AgentProviderContractV1 {
    /// Provider identifiers served by this implementation. The contract does
    /// not define a closed provider enum.
    pub provider_ids: Vec<ProviderIdV1>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
pub struct RuntimeAdapterContractV1 {
    /// Runtime kinds served by this implementation, such as a bundled local or
    /// remote adapter. Values are extension-defined stable IDs.
    pub runtime_kinds: Vec<RuntimeKindIdV1>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
pub struct WorkspaceToolProviderContractV1 {
    /// Tool kinds are extension-defined stable IDs. `formatter`, `linter`,
    /// `test`, and `preview` are conventional values, not a closed enum.
    pub tool_kinds: Vec<WorkspaceToolKindIdV1>,
    #[serde(default)]
    pub languages: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
pub struct FileViewProviderContractV1 {
    #[serde(default)]
    pub media_types: Vec<String>,
    #[serde(default)]
    pub file_extensions: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(tag = "kind", content = "contract", rename_all = "snake_case")]
pub enum ExtensionContractV1 {
    AgentProvider(AgentProviderContractV1),
    RuntimeAdapter(RuntimeAdapterContractV1),
    WorkspaceToolProvider(WorkspaceToolProviderContractV1),
    FileViewProvider(FileViewProviderContractV1),
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
pub struct ExtensionDescriptorV1 {
    pub schema_version: u16,
    pub id: ExtensionIdV1,
    pub display_name: String,
    pub api: ApiVersionRangeV1,
    #[serde(default)]
    pub capabilities: CapabilityDeclarationV1,
    #[serde(default)]
    pub permissions: Vec<PermissionIdV1>,
    pub extension: ExtensionContractV1,
}

impl ExtensionDescriptorV1 {
    pub fn validate(&self) -> Result<(), DescriptorValidationError> {
        if self.schema_version != EXTENSION_DESCRIPTOR_SCHEMA_VERSION {
            return Err(DescriptorValidationError::new(format!(
                "unsupported descriptor schema version {}; expected {}",
                self.schema_version, EXTENSION_DESCRIPTOR_SCHEMA_VERSION
            )));
        }
        if self.display_name.trim().is_empty() {
            return Err(DescriptorValidationError::new(
                "display_name must not be empty".to_owned(),
            ));
        }
        if self.display_name.trim() != self.display_name {
            return Err(DescriptorValidationError::new(
                "display_name must not contain surrounding whitespace".to_owned(),
            ));
        }
        if !self.api.is_valid() {
            return Err(DescriptorValidationError::new(
                "API version range must be non-zero and ordered".to_owned(),
            ));
        }
        self.capabilities.validate()?;
        reject_duplicates("permissions", &self.permissions)?;
        match &self.extension {
            ExtensionContractV1::AgentProvider(contract) => {
                reject_non_empty_unique("provider_ids", &contract.provider_ids)?;
            }
            ExtensionContractV1::RuntimeAdapter(contract) => {
                reject_non_empty_unique("runtime_kinds", &contract.runtime_kinds)?;
            }
            ExtensionContractV1::WorkspaceToolProvider(contract) => {
                reject_non_empty_unique("tool_kinds", &contract.tool_kinds)?;
            }
            ExtensionContractV1::FileViewProvider(contract) => {
                if contract.media_types.is_empty() && contract.file_extensions.is_empty() {
                    return Err(DescriptorValidationError::new(
                        "file view must declare at least one media type or file extension"
                            .to_owned(),
                    ));
                }
            }
        }
        Ok(())
    }
}

fn reject_non_empty_unique<T>(label: &str, values: &[T]) -> Result<(), DescriptorValidationError>
where
    T: Ord + fmt::Debug,
{
    if values.is_empty() {
        return Err(DescriptorValidationError::new(format!(
            "{label} must not be empty"
        )));
    }
    reject_duplicates(label, values)
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DescriptorValidationError {
    message: String,
}

impl DescriptorValidationError {
    fn new(message: String) -> Self {
        Self { message }
    }
}

impl fmt::Display for DescriptorValidationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for DescriptorValidationError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stable_ids_are_rejected_instead_of_coerced() {
        assert!(ExtensionIdV1::new("generalaction.emdash").is_ok());
        for invalid in [
            "",
            " Claude",
            "claude ",
            "Claude",
            "1claude",
            "claude..code",
            "claude/",
            "claude-",
        ] {
            assert!(
                ExtensionIdV1::new(invalid).is_err(),
                "{invalid:?} should be invalid"
            );
        }
    }

    #[test]
    fn deserialization_validates_stable_ids() {
        let result = serde_json::from_str::<ExtensionIdV1>("\"UpperCase\"");
        assert!(result.is_err());
    }

    #[test]
    fn negotiates_the_highest_common_version() {
        assert_eq!(
            ApiVersionRangeV1::new(1, 2).highest_common(ApiVersionRangeV1::new(2, 3)),
            Some(2)
        );
        assert_eq!(
            ApiVersionRangeV1::new(1, 2).highest_common(ApiVersionRangeV1::new(3, 4)),
            None
        );
    }
}
