use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Deserializer, Serialize};
use ts_rs::TS;

use crate::{PluginContractValidationErrorV2, StableIdError, contract::validate_stable_id};

pub const PLUGIN_SETTINGS_SCHEMA_VERSION_V1: u16 = 1;

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, TS)]
#[ts(type = "string")]
pub struct PluginSettingKeyV1(String);

impl PluginSettingKeyV1 {
    pub fn new(value: impl Into<String>) -> Result<Self, StableIdError> {
        let value = value.into();
        validate_stable_id(&value)?;
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for PluginSettingKeyV1 {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::new(value).map_err(serde::de::Error::custom)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum PluginSettingScopeV1 {
    User,
    Workspace,
    Profile,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
pub struct PluginSettingChoiceV1 {
    pub value: String,
    pub label: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PluginSettingDefinitionV1 {
    Boolean {
        key: PluginSettingKeyV1,
        title: String,
        description: String,
        scope: PluginSettingScopeV1,
        default: bool,
    },
    Integer {
        key: PluginSettingKeyV1,
        title: String,
        description: String,
        scope: PluginSettingScopeV1,
        default: i32,
        minimum: i32,
        maximum: i32,
    },
    Choice {
        key: PluginSettingKeyV1,
        title: String,
        description: String,
        scope: PluginSettingScopeV1,
        default: String,
        options: Vec<PluginSettingChoiceV1>,
    },
}

impl PluginSettingDefinitionV1 {
    pub fn key(&self) -> &PluginSettingKeyV1 {
        match self {
            Self::Boolean { key, .. } | Self::Integer { key, .. } | Self::Choice { key, .. } => key,
        }
    }

    pub fn scope(&self) -> &PluginSettingScopeV1 {
        match self {
            Self::Boolean { scope, .. }
            | Self::Integer { scope, .. }
            | Self::Choice { scope, .. } => scope,
        }
    }

    fn default_value(&self) -> PluginSettingValueV1 {
        match self {
            Self::Boolean { default, .. } => PluginSettingValueV1::Boolean(*default),
            Self::Integer { default, .. } => PluginSettingValueV1::Integer(*default),
            Self::Choice { default, .. } => PluginSettingValueV1::String(default.clone()),
        }
    }

    fn validate(&self) -> Result<(), PluginContractValidationErrorV2> {
        let (title, description) = match self {
            Self::Boolean {
                title, description, ..
            }
            | Self::Integer {
                title, description, ..
            }
            | Self::Choice {
                title, description, ..
            } => (title, description),
        };
        validate_copy("title", title)?;
        validate_copy("description", description)?;

        match self {
            Self::Boolean { .. } => Ok(()),
            Self::Integer {
                key,
                default,
                minimum,
                maximum,
                ..
            } => {
                if minimum > maximum {
                    return Err(PluginContractValidationErrorV2::new(format!(
                        "plugin setting {} has an inverted integer range",
                        key.as_str()
                    )));
                }
                if default < minimum || default > maximum {
                    return Err(PluginContractValidationErrorV2::new(format!(
                        "plugin setting {} default is outside its integer range",
                        key.as_str()
                    )));
                }
                Ok(())
            }
            Self::Choice {
                key,
                default,
                options,
                ..
            } => {
                if options.is_empty() {
                    return Err(PluginContractValidationErrorV2::new(format!(
                        "plugin setting {} must declare at least one choice",
                        key.as_str()
                    )));
                }
                let mut values = BTreeSet::new();
                for option in options {
                    validate_copy("choice value", &option.value)?;
                    validate_copy("choice label", &option.label)?;
                    if !values.insert(&option.value) {
                        return Err(PluginContractValidationErrorV2::new(format!(
                            "plugin setting {} contains duplicate choice {:?}",
                            key.as_str(),
                            option.value
                        )));
                    }
                }
                if !values.contains(default) {
                    return Err(PluginContractValidationErrorV2::new(format!(
                        "plugin setting {} default is not one of its choices",
                        key.as_str()
                    )));
                }
                Ok(())
            }
        }
    }
}

fn validate_copy(field: &str, value: &str) -> Result<(), PluginContractValidationErrorV2> {
    if value.trim().is_empty() || value.trim() != value || value.len() > 512 {
        return Err(PluginContractValidationErrorV2::new(format!(
            "plugin setting {field} must be non-empty, trimmed, and at most 512 bytes"
        )));
    }
    Ok(())
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(untagged)]
pub enum PluginSettingValueV1 {
    Boolean(bool),
    Integer(i32),
    String(String),
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
pub struct PluginSettingsSchemaV1 {
    pub schema_version: u16,
    #[serde(default)]
    pub settings: Vec<PluginSettingDefinitionV1>,
}

impl PluginSettingsSchemaV1 {
    pub fn validate(&self) -> Result<(), PluginContractValidationErrorV2> {
        if self.schema_version != PLUGIN_SETTINGS_SCHEMA_VERSION_V1 {
            return Err(PluginContractValidationErrorV2::new(format!(
                "unsupported plugin settings schema version {}; expected {}",
                self.schema_version, PLUGIN_SETTINGS_SCHEMA_VERSION_V1
            )));
        }
        let mut keys = BTreeSet::new();
        for definition in &self.settings {
            if !keys.insert(definition.key()) {
                return Err(PluginContractValidationErrorV2::new(format!(
                    "plugin settings schema contains duplicate key {}",
                    definition.key().as_str()
                )));
            }
            definition.validate()?;
        }
        Ok(())
    }

    pub fn defaults(
        &self,
        scope: PluginSettingScopeV1,
    ) -> BTreeMap<PluginSettingKeyV1, PluginSettingValueV1> {
        self.settings
            .iter()
            .filter(|definition| definition.scope() == &scope)
            .map(|definition| (definition.key().clone(), definition.default_value()))
            .collect()
    }

    pub fn validate_values(
        &self,
        scope: PluginSettingScopeV1,
        values: &BTreeMap<PluginSettingKeyV1, PluginSettingValueV1>,
    ) -> Result<(), PluginContractValidationErrorV2> {
        self.validate()?;
        let definitions = self
            .settings
            .iter()
            .map(|definition| (definition.key(), definition))
            .collect::<BTreeMap<_, _>>();
        for (key, value) in values {
            let Some(definition) = definitions.get(key) else {
                return Err(PluginContractValidationErrorV2::new(format!(
                    "plugin setting {} is not declared",
                    key.as_str()
                )));
            };
            if definition.scope() != &scope {
                return Err(PluginContractValidationErrorV2::new(format!(
                    "plugin setting {} does not belong to the requested scope",
                    key.as_str()
                )));
            }
            let valid = match (definition, value) {
                (PluginSettingDefinitionV1::Boolean { .. }, PluginSettingValueV1::Boolean(_)) => {
                    true
                }
                (
                    PluginSettingDefinitionV1::Integer {
                        minimum, maximum, ..
                    },
                    PluginSettingValueV1::Integer(value),
                ) => value >= minimum && value <= maximum,
                (
                    PluginSettingDefinitionV1::Choice { options, .. },
                    PluginSettingValueV1::String(value),
                ) => options.iter().any(|option| option.value == *value),
                _ => false,
            };
            if !valid {
                return Err(PluginContractValidationErrorV2::new(format!(
                    "plugin setting {} has an invalid value",
                    key.as_str()
                )));
            }
        }
        Ok(())
    }
}
