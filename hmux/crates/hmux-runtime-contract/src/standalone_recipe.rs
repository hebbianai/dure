use crate::{RuntimeContractError, StandaloneCreateRequest, StandaloneResurrectionRecipe};

impl StandaloneResurrectionRecipe {
    /// Reconstruct every saved launch input before a caller adds its new
    /// recovery identity. Reading a recipe does not grant source-stop authority.
    pub fn to_create_request(&self) -> Result<StandaloneCreateRequest, RuntimeContractError> {
        StandaloneCreateRequest::new(
            self.provider_cwd(),
            Some(self.session_name().to_owned()),
            self.command().to_vec(),
            self.initial_rows(),
            self.initial_columns(),
        )?
        .with_resurrection_replay_policy(self.resurrection_replay_policy())?
        .with_terminal_environment(self.terminal_environment().clone())?
        .with_retirement_policy_option(self.retirement_policy())?
        .with_terminal_default_colors_option(self.terminal_default_colors())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{StandaloneResurrectionReplayPolicy, TerminalDefaultColors, TerminalEnvironment};
    use hmux_session_protocol::discovery::SessionRetirementPolicy;
    use std::collections::BTreeMap;

    #[test]
    fn reconstruction_preserves_the_complete_launch_request_without_recovery_authority() {
        let cwd = std::env::temp_dir();
        let command = vec!["shell".into(), "-c".into(), "run-explicit-job".into()];
        let environment = TerminalEnvironment::new(BTreeMap::from([
            ("TERM".into(), Some("xterm-256color".into())),
            ("NO_COLOR".into(), None),
        ]))
        .unwrap();
        let policy = SessionRetirementPolicy::AfterGracefulLastClientDepartureV1 {
            grace_period_ms: 2_000,
        };
        let colors = TerminalDefaultColors::new(0x123456, 0x789abc).unwrap();
        let replay = StandaloneResurrectionReplayPolicy::ConfirmExplicitCommand;
        let recipe =
            StandaloneResurrectionRecipe::new("saved-session", &cwd, command.clone(), 37, 119, 1)
                .unwrap()
                .with_terminal_environment(environment.clone())
                .unwrap()
                .with_resurrection_replay_policy(replay)
                .unwrap()
                .with_retirement_policy(policy)
                .unwrap()
                .with_terminal_default_colors(colors)
                .unwrap();
        let expected =
            StandaloneCreateRequest::new(cwd, Some("saved-session".into()), command, 37, 119)
                .unwrap()
                .with_terminal_environment(environment)
                .unwrap()
                .with_resurrection_replay_policy(replay)
                .unwrap()
                .with_retirement_policy(policy)
                .unwrap()
                .with_terminal_default_colors(colors)
                .unwrap();

        let persisted = serde_json::to_vec(&recipe).unwrap();
        let reopened: StandaloneResurrectionRecipe = serde_json::from_slice(&persisted).unwrap();
        let request = reopened.to_create_request().unwrap();
        assert_eq!(request, expected);
        assert_eq!(request.recovery_identity(), None);
    }

    #[test]
    fn legacy_reconstruction_preserves_absent_policy_and_colors() {
        let recipe = StandaloneResurrectionRecipe::new(
            "legacy",
            std::env::temp_dir(),
            Vec::new(),
            24,
            80,
            1,
        )
        .unwrap();
        let request = recipe.to_create_request().unwrap();
        assert_eq!(request.retirement_policy(), None);
        assert_eq!(request.terminal_default_colors(), None);
        assert_eq!(request.recovery_identity(), None);
        assert_eq!(
            request.resurrection_replay_policy(),
            StandaloneResurrectionReplayPolicy::SafeInteractiveShell
        );
    }
}
