use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OutputLimitAction {
    /// Stop capturing the overflowing stream, but still await the command outcome.
    CloseStream,
    /// Terminate the owned process tree and return `CommandFailure::OutputLimit`.
    TerminateProcessTree,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommandSpec {
    program: PathBuf,
    arguments: Vec<OsString>,
    current_directory: Option<PathBuf>,
    clear_environment: bool,
    environment: Vec<(OsString, OsString)>,
    input: Option<Vec<u8>>,
    capture_stderr: bool,
    output_limit_action: OutputLimitAction,
}

impl CommandSpec {
    #[must_use]
    pub fn new(program: impl Into<PathBuf>) -> Self {
        Self {
            program: program.into(),
            arguments: Vec::new(),
            current_directory: None,
            clear_environment: false,
            environment: Vec::new(),
            input: None,
            capture_stderr: false,
            output_limit_action: OutputLimitAction::CloseStream,
        }
    }

    pub fn arg(&mut self, argument: impl AsRef<OsStr>) -> &mut Self {
        self.arguments.push(argument.as_ref().to_owned());
        self
    }

    pub fn args<I, S>(&mut self, arguments: I) -> &mut Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        self.arguments.extend(
            arguments
                .into_iter()
                .map(|argument| argument.as_ref().to_owned()),
        );
        self
    }

    pub fn current_dir(&mut self, directory: impl Into<PathBuf>) -> &mut Self {
        self.current_directory = Some(directory.into());
        self
    }

    pub fn clear_env(&mut self) -> &mut Self {
        self.clear_environment = true;
        self
    }

    pub fn env(&mut self, key: impl AsRef<OsStr>, value: impl AsRef<OsStr>) -> &mut Self {
        self.environment
            .push((key.as_ref().to_owned(), value.as_ref().to_owned()));
        self
    }

    /// Supplies a finite stdin snapshot through a private, seekable temporary file.
    /// No pipe writer can block execution when the child does not read its input.
    pub fn input(&mut self, bytes: impl Into<Vec<u8>>) -> &mut Self {
        self.input = Some(bytes.into());
        self
    }

    /// Captures stderr separately with the same per-stream bound as stdout.
    /// Existing probes discard stderr unless they explicitly select capture.
    pub fn capture_stderr(&mut self, capture: bool) -> &mut Self {
        self.capture_stderr = capture;
        self
    }

    pub fn on_output_limit(&mut self, action: OutputLimitAction) -> &mut Self {
        self.output_limit_action = action;
        self
    }

    pub(crate) fn output_limit_action(&self) -> OutputLimitAction {
        self.output_limit_action
    }

    pub(crate) fn input_bytes(&self) -> Option<&[u8]> {
        self.input.as_deref()
    }
    pub(crate) fn captures_stderr(&self) -> bool {
        self.capture_stderr
    }

    #[must_use]
    pub fn program(&self) -> &Path {
        &self.program
    }
    #[must_use]
    pub fn arguments(&self) -> &[OsString] {
        &self.arguments
    }
    #[must_use]
    pub fn current_directory(&self) -> Option<&Path> {
        self.current_directory.as_deref()
    }
    #[must_use]
    pub fn clears_environment(&self) -> bool {
        self.clear_environment
    }
    #[must_use]
    pub fn environment(&self) -> &[(OsString, OsString)] {
        &self.environment
    }
}
