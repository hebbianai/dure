use serde::{Deserialize, Serialize};

const MAX_MODEL_SELECTION_BYTES: usize = 256;
const MAX_EFFORT_SELECTION_BYTES: usize = 64;

/// Provider-scoped model override. Opaque to the core; only its shape is
/// validated, so a provider adapter owns the argv mapping and the core stays
/// neutral about which models a provider offers.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(try_from = "String", into = "String")]
pub struct AgentSpawnModelSelectionV1(String);

fn valid_launch_selection(value: &str, model: bool) -> bool {
    let maximum = if model {
        MAX_MODEL_SELECTION_BYTES
    } else {
        MAX_EFFORT_SELECTION_BYTES
    };
    let valid_len = (1..=maximum).contains(&value.len());
    let valid_start = value
        .chars()
        .next()
        .is_some_and(|character| character.is_ascii_alphanumeric());
    let valid_chars = value.chars().all(|c| {
        c.is_ascii_alphanumeric()
            || matches!(c, '.' | '_' | '-')
            || (model && matches!(c, '[' | ']' | '/' | ':'))
    });
    valid_len && valid_start && valid_chars
}

impl AgentSpawnModelSelectionV1 {
    pub fn parse(value: &str) -> Result<Self, String> {
        if valid_launch_selection(value, true) {
            Ok(Self(value.to_string()))
        } else {
            Err("agent_spawn_model_invalid".to_string())
        }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for AgentSpawnModelSelectionV1 {
    type Error = String;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::parse(&value)
    }
}

impl From<AgentSpawnModelSelectionV1> for String {
    fn from(value: AgentSpawnModelSelectionV1) -> Self {
        value.0
    }
}

/// Provider-scoped reasoning-effort override. Same opaque-token contract as
/// the model selection: the core validates the shape only, and the provider
/// adapter owns the argv mapping, so effort ladders can evolve per provider
/// generation without a core contract change.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(try_from = "String", into = "String")]
pub struct AgentSpawnEffortSelectionV1(String);

impl AgentSpawnEffortSelectionV1 {
    pub fn parse(value: &str) -> Result<Self, String> {
        if valid_launch_selection(value, false) {
            Ok(Self(value.to_string()))
        } else {
            Err("agent_spawn_effort_invalid".to_string())
        }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for AgentSpawnEffortSelectionV1 {
    type Error = String;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::parse(&value)
    }
}

impl From<AgentSpawnEffortSelectionV1> for String {
    fn from(value: AgentSpawnEffortSelectionV1) -> Self {
        value.0
    }
}
