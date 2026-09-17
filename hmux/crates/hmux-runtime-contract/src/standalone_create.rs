use super::{
    BROKER_SCHEMA_V1, BROKER_SCHEMA_V2, BROKER_SCHEMA_V3, BROKER_SCHEMA_VERSION_V1,
    BROKER_SCHEMA_VERSION_V2, BROKER_SCHEMA_VERSION_V3, MAX_COMMAND_ARGUMENT_BYTES,
    MAX_COMMAND_ARGUMENTS, MAX_SESSION_NAME_BYTES, RuntimeContractError, SessionRetirementPolicy,
    StandaloneRecoveryCreateIdentity, StandaloneResurrectionReplayPolicy, TerminalDefaultColors,
    TerminalEnvironment, effective_resurrection_replay_policy, validate_resurrection_replay_policy,
};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const STANDALONE_OPERATION_BOUND_CREATE_CAPABILITY: &str =
    "standalone_operation_bound_create_v1";
const OPERATION_BOUND_SCHEMA: &str = "hmux-standalone-create-v4";
pub const STANDALONE_LOCATED_OPERATION_CREATE_CAPABILITY: &str =
    "standalone_located_operation_create_v1";
const LOCATED_OPERATION_SCHEMA: &str = "hmux-standalone-create-v5";

#[cfg(test)]
mod tests;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StandaloneCreateRequest {
    schema: String,
    schema_version: u16,
    provider_cwd: PathBuf,
    session_name: Option<String>,
    command: Vec<String>,
    initial_rows: u16,
    initial_columns: u16,
    #[serde(default, skip_serializing_if = "TerminalEnvironment::is_empty")]
    terminal_environment: TerminalEnvironment,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    resurrection_replay_policy: Option<StandaloneResurrectionReplayPolicy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    recovery_identity: Option<StandaloneRecoveryCreateIdentity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    recovery_operation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    recovery_operation_root: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    retirement_policy: Option<SessionRetirementPolicy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    terminal_default_colors: Option<TerminalDefaultColors>,
}

impl StandaloneCreateRequest {
    pub fn shell(
        provider_cwd: impl Into<PathBuf>,
        initial_rows: u16,
        initial_columns: u16,
    ) -> Result<Self, RuntimeContractError> {
        Self::new(
            provider_cwd,
            None,
            Vec::new(),
            initial_rows,
            initial_columns,
        )
    }

    pub fn new(
        provider_cwd: impl Into<PathBuf>,
        session_name: Option<String>,
        command: Vec<String>,
        initial_rows: u16,
        initial_columns: u16,
    ) -> Result<Self, RuntimeContractError> {
        let request = Self {
            schema: BROKER_SCHEMA_V1.to_string(),
            schema_version: BROKER_SCHEMA_VERSION_V1,
            provider_cwd: provider_cwd.into(),
            session_name,
            command,
            initial_rows,
            initial_columns,
            terminal_environment: TerminalEnvironment::default(),
            resurrection_replay_policy: None,
            recovery_identity: None,
            recovery_operation_id: None,
            recovery_operation_root: None,
            retirement_policy: None,
            terminal_default_colors: None,
        };
        request.validate()?;
        Ok(request)
    }

    pub fn with_terminal_environment(
        mut self,
        terminal_environment: TerminalEnvironment,
    ) -> Result<Self, RuntimeContractError> {
        terminal_environment.validate()?;
        self.terminal_environment = terminal_environment;
        self.validate()?;
        Ok(self)
    }

    pub fn with_resurrection_replay_policy(
        mut self,
        resurrection_replay_policy: StandaloneResurrectionReplayPolicy,
    ) -> Result<Self, RuntimeContractError> {
        self.resurrection_replay_policy = Some(resurrection_replay_policy);
        self.validate()?;
        Ok(self)
    }

    pub fn with_recovery_identity(
        mut self,
        recovery_identity: StandaloneRecoveryCreateIdentity,
    ) -> Result<Self, RuntimeContractError> {
        recovery_identity.validate()?;
        self.recovery_identity = Some(recovery_identity);
        self.validate()?;
        Ok(self)
    }

    /// Bind the detached broker to the immutable operation in its discovery
    /// namespace. Older brokers must reject this schema, never ignore the binding.
    pub fn with_recovery_operation_id(
        mut self,
        operation_id: impl Into<String>,
    ) -> Result<Self, RuntimeContractError> {
        self.recovery_operation_id = Some(operation_id.into());
        self.refresh_schema();
        self.validate()?;
        Ok(self)
    }

    #[must_use]
    pub fn recovery_operation_id(&self) -> Option<&str> {
        self.recovery_operation_id.as_deref()
    }

    /// Address an existing operation independently of the broker's target
    /// namespace. Older brokers must reject v5 rather than ignore this address.
    pub fn with_recovery_operation_at(
        mut self,
        operation_id: impl Into<String>,
        operation_root: impl Into<PathBuf>,
    ) -> Result<Self, RuntimeContractError> {
        self.recovery_operation_id = Some(operation_id.into());
        self.recovery_operation_root = Some(operation_root.into());
        self.refresh_schema();
        self.validate()?;
        Ok(self)
    }

    #[must_use]
    pub fn recovery_operation_root(&self) -> Option<&Path> {
        self.recovery_operation_root.as_deref()
    }

    /// Negotiate optional operation binding once during fresh preparation.
    /// Persist the result; replay consumes that request without renegotiating.
    pub fn with_negotiated_recovery_operation(
        self,
        operation_id: &str,
        operation_root: &Path,
        target_root: &Path,
        capabilities: &[String],
    ) -> Result<Self, RuntimeContractError> {
        let supports = |capability| capabilities.iter().any(|value| value == capability);
        if operation_root == target_root && supports(STANDALONE_OPERATION_BOUND_CREATE_CAPABILITY) {
            self.with_recovery_operation_id(operation_id)
        } else if supports(STANDALONE_LOCATED_OPERATION_CREATE_CAPABILITY) {
            self.with_recovery_operation_at(operation_id, operation_root)
        } else {
            Ok(self)
        }
    }

    /// Remove private recovery authority while preserving the complete public
    /// standalone request.
    #[must_use]
    pub fn without_recovery_identity(mut self) -> Self {
        self.recovery_identity = None;
        self.recovery_operation_id = None;
        self.recovery_operation_root = None;
        self.refresh_schema();
        self
    }

    pub fn with_retirement_policy(
        self,
        retirement_policy: SessionRetirementPolicy,
    ) -> Result<Self, RuntimeContractError> {
        self.with_retirement_policy_option(Some(retirement_policy))
    }

    pub fn with_retirement_policy_option(
        mut self,
        retirement_policy: Option<SessionRetirementPolicy>,
    ) -> Result<Self, RuntimeContractError> {
        if retirement_policy.is_some_and(|policy| !policy.is_valid()) {
            return Err(RuntimeContractError::new(
                "standalone retirement policy is invalid",
            ));
        }
        self.retirement_policy = retirement_policy;
        self.refresh_schema();
        self.validate()?;
        Ok(self)
    }

    pub fn with_terminal_default_colors(
        self,
        colors: TerminalDefaultColors,
    ) -> Result<Self, RuntimeContractError> {
        self.with_terminal_default_colors_option(Some(colors))
    }

    pub fn with_terminal_default_colors_option(
        mut self,
        colors: Option<TerminalDefaultColors>,
    ) -> Result<Self, RuntimeContractError> {
        if let Some(colors) = colors {
            colors
                .validate()
                .map_err(|error| RuntimeContractError::new(error.to_string()))?;
        }
        self.terminal_default_colors = colors;
        self.refresh_schema();
        self.validate()?;
        Ok(self)
    }

    #[must_use]
    pub fn provider_cwd(&self) -> &Path {
        &self.provider_cwd
    }

    #[must_use]
    pub fn session_name(&self) -> Option<&str> {
        self.session_name.as_deref()
    }

    #[must_use]
    pub fn command(&self) -> &[String] {
        &self.command
    }

    #[must_use]
    pub fn initial_rows(&self) -> u16 {
        self.initial_rows
    }

    #[must_use]
    pub fn initial_columns(&self) -> u16 {
        self.initial_columns
    }

    #[must_use]
    pub fn terminal_environment(&self) -> &TerminalEnvironment {
        &self.terminal_environment
    }

    #[must_use]
    pub fn resurrection_replay_policy(&self) -> StandaloneResurrectionReplayPolicy {
        effective_resurrection_replay_policy(&self.command, self.resurrection_replay_policy)
    }

    /// Return only the replay-policy hint that was explicitly present on the
    /// create request. `None` is a compatibility omission, so a runtime
    /// restoring an existing durable recipe must not treat the derived default
    /// as replacement authority.
    #[must_use]
    pub fn explicit_resurrection_replay_policy(
        &self,
    ) -> Option<StandaloneResurrectionReplayPolicy> {
        self.resurrection_replay_policy
    }

    #[must_use]
    pub fn recovery_identity(&self) -> Option<&StandaloneRecoveryCreateIdentity> {
        self.recovery_identity.as_ref()
    }

    #[must_use]
    pub fn retirement_policy(&self) -> Option<SessionRetirementPolicy> {
        self.retirement_policy
    }

    #[must_use]
    pub fn terminal_default_colors(&self) -> Option<TerminalDefaultColors> {
        self.terminal_default_colors
    }

    pub fn validate(&self) -> Result<(), RuntimeContractError> {
        let policy_valid = self
            .retirement_policy
            .is_none_or(SessionRetirementPolicy::is_valid);
        let schema_valid = if self.recovery_operation_root.is_some() {
            self.schema == LOCATED_OPERATION_SCHEMA && self.schema_version == 5
        } else if self.recovery_operation_id.is_some() {
            self.schema == OPERATION_BOUND_SCHEMA && self.schema_version == 4
        } else {
            match (self.terminal_default_colors, self.retirement_policy) {
                (Some(_), _) => {
                    self.schema == BROKER_SCHEMA_V3
                        && self.schema_version == BROKER_SCHEMA_VERSION_V3
                }
                (None, None) => {
                    self.schema == BROKER_SCHEMA_V1
                        && self.schema_version == BROKER_SCHEMA_VERSION_V1
                }
                (None, Some(_)) => {
                    self.schema == BROKER_SCHEMA_V2
                        && self.schema_version == BROKER_SCHEMA_VERSION_V2
                }
            }
        };
        if !policy_valid || !schema_valid {
            return Err(RuntimeContractError::new(
                "standalone create request has an unsupported schema",
            ));
        }
        if !self.provider_cwd.is_absolute() {
            return Err(RuntimeContractError::new(
                "standalone create provider cwd must be absolute",
            ));
        }
        if self.initial_rows == 0 || self.initial_columns == 0 {
            return Err(RuntimeContractError::new(
                "standalone create terminal dimensions must be non-zero",
            ));
        }
        if self.session_name.as_ref().is_some_and(|name| {
            name.trim().is_empty()
                || name.len() > MAX_SESSION_NAME_BYTES
                || name.chars().any(char::is_control)
        }) {
            return Err(RuntimeContractError::new(
                "standalone create session name is invalid",
            ));
        }
        if self.command.len() > MAX_COMMAND_ARGUMENTS
            || self.command.iter().any(|argument| {
                argument.is_empty()
                    || argument.len() > MAX_COMMAND_ARGUMENT_BYTES
                    || argument.contains('\0')
            })
        {
            return Err(RuntimeContractError::new(
                "standalone create command is invalid",
            ));
        }
        if let Some(operation_id) = &self.recovery_operation_id {
            if self.recovery_identity.is_none()
                || operation_id.is_empty()
                || operation_id.len() > 4096
                || operation_id.chars().any(char::is_control)
            {
                return Err(RuntimeContractError::new(
                    "standalone create operation binding is invalid",
                ));
            }
        }
        if self
            .recovery_operation_root
            .as_ref()
            .is_some_and(|root| !root.is_absolute() || self.recovery_operation_id.is_none())
        {
            return Err(RuntimeContractError::new(
                "standalone create operation namespace is invalid",
            ));
        }
        self.terminal_environment.validate()?;
        if let Some(colors) = self.terminal_default_colors {
            colors
                .validate()
                .map_err(|error| RuntimeContractError::new(error.to_string()))?;
        }
        validate_resurrection_replay_policy(&self.command, self.resurrection_replay_policy)?;
        if let Some(identity) = self.recovery_identity.as_ref() {
            identity.validate()?;
            if self.session_name.is_none() {
                return Err(RuntimeContractError::new(
                    "standalone recovery create requires a session name",
                ));
            }
        }
        Ok(())
    }

    fn refresh_schema(&mut self) {
        let (schema, version) = if self.recovery_operation_root.is_some() {
            (LOCATED_OPERATION_SCHEMA, 5)
        } else if self.recovery_operation_id.is_some() {
            (OPERATION_BOUND_SCHEMA, 4)
        } else if self.terminal_default_colors.is_some() {
            (BROKER_SCHEMA_V3, BROKER_SCHEMA_VERSION_V3)
        } else if self.retirement_policy.is_some() {
            (BROKER_SCHEMA_V2, BROKER_SCHEMA_VERSION_V2)
        } else {
            (BROKER_SCHEMA_V1, BROKER_SCHEMA_VERSION_V1)
        };
        self.schema = schema.to_string();
        self.schema_version = version;
    }
}
