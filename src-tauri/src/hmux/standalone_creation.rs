use super::{project_session, HmuxManager, SessionSummary};
pub(crate) use crate::standalone_create_request::AppStandaloneCreateRequest;
use dure_app::OperationIdV1;
use hmux_client::{
    SessionClass, StandaloneCreateRequest, TerminalDefaultColors,
    TerminalEnvironment,
};
use tauri::{AppHandle, Runtime};

#[cfg(all(test, unix))]
mod checkout_tests;

impl HmuxManager {
    pub fn create_standalone<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        cwd: String,
        rows: u16,
        columns: u16,
        terminal_environment: TerminalEnvironment,
    ) -> Result<SessionSummary, String> {
        self.create_standalone_command(
            app, cwd, rows, columns,
            crate::remote_hmux::local_shell_with_ssh_shim(), terminal_environment,
        )
    }

    /// App-owned standalone session. `command` runs an explicit one-shot
    /// program (login/setup command panes); `None` launches the default
    /// interactive shell. Both retire with the app by default.
    pub fn create_app_standalone<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        request: AppStandaloneCreateRequest,
    ) -> Result<SessionSummary, String> {
        let command = match request.command_line.as_deref().map(str::trim) {
            Some("") => return Err("standalone command line must be non-empty".to_string()),
            Some(line) => crate::remote_hmux::login_shell_command(line),
            None => crate::remote_hmux::local_shell_with_ssh_shim(),
        };
        let (operation, request) = request.prepare(command)?;
        let request = super::retirement::app_standalone_create_request(request)?;
        self.create_standalone_request(app, operation, request)
    }

    pub(crate) fn create_standalone_command<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        cwd: String,
        rows: u16,
        columns: u16,
        command: Vec<String>,
        terminal_environment: TerminalEnvironment,
    ) -> Result<SessionSummary, String> {
        let (operation, request) = AppStandaloneCreateRequest {
            operation_id: None,
            cwd,
            rows,
            columns,
            terminal_env: Some(terminal_environment.values().clone()),
            command_line: None,
            terminal_default_colors: TerminalDefaultColors::default(),
        }.prepare(command)?;
        self.create_standalone_request(app, operation, request)
    }

    fn create_standalone_request<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        operation: OperationIdV1,
        request: StandaloneCreateRequest,
    ) -> Result<SessionSummary, String> {
        let _operation = self.operations.lock().expect("Hmux operations poisoned");
        let runtime = super::runtime::resolve_runtime(app)?;
        let created = crate::session_checkout::create_standalone(runtime, None, operation, request)?;
        let descriptor = created.session().descriptor().clone();
        if descriptor.session_class != SessionClass::Standalone {
            return Err("standalone Hmux runtime returned a managed session".to_string());
        }
        let session_id = descriptor.session_id.clone();
        self.pending_created
            .lock()
            .expect("Hmux pending create registry poisoned")
            .insert(session_id, created);
        Ok(project_session(descriptor))
    }
}
