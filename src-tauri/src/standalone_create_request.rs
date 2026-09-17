//! Shared IPC normalization for local standalone creation on every platform.

use dure_app::OperationIdV1;
use hmux_client::{StandaloneCreateRequest, TerminalDefaultColors, TerminalEnvironment};
use serde::Deserialize;
use std::collections::BTreeMap;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AppStandaloneCreateRequest {
    pub operation_id: Option<OperationIdV1>,
    pub cwd: String,
    pub rows: u16,
    pub columns: u16,
    pub terminal_env: Option<BTreeMap<String, Option<String>>>,
    pub command_line: Option<String>,
    pub terminal_default_colors: TerminalDefaultColors,
}

impl AppStandaloneCreateRequest {
    pub fn prepare(
        self,
        command: Vec<String>,
    ) -> Result<(OperationIdV1, StandaloneCreateRequest), String> {
        // Older clients have no retry identity and submit a fresh intent.
        // Correlated callers retain their existing identity across retries.
        let operation = match self.operation_id {
            Some(operation) => operation,
            None => {
                let mut bytes = [0_u8; 32];
                getrandom::fill(&mut bytes).map_err(|error| error.to_string())?;
                let id: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
                OperationIdV1::new(id).expect("hex entropy is a valid operation identity")
            }
        };
        let cwd = std::fs::canonicalize(&self.cwd)
            .map_err(|error| format!("resolve standalone Hmux cwd failed: {error}"))?;
        if !cwd.is_dir() {
            return Err("standalone Hmux cwd must be a directory".into());
        }
        let name = format!(
            "terminal-{}",
            hmux_client::recovery_journal::request_fingerprint(&[operation.as_str()])
        );
        let environment = TerminalEnvironment::new(self.terminal_env.unwrap_or_default())
            .map_err(|error| error.to_string())?;
        let request =
            StandaloneCreateRequest::new(cwd, Some(name), command, self.rows, self.columns)
                .and_then(|request| request.with_terminal_environment(environment))
                .and_then(|request| {
                    request.with_terminal_default_colors(self.terminal_default_colors)
                })
                .map_err(|error| error.to_string())?;
        Ok((operation, request))
    }
}
