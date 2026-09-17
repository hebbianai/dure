use crate::ClientError;
use hmux_runtime_contract::{read_json_frame, write_json_frame};
use serde::Serialize;
use serde::de::DeserializeOwned;
use std::io::Read;
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::thread::{self, JoinHandle};

const MAX_STDERR_BYTES: usize = 256 * 1024;

pub(crate) struct RuntimeBroker<Response> {
    label: &'static str,
    error_code: &'static str,
    child: Option<Child>,
    input: Option<ChildStdin>,
    response_reader:
        Option<JoinHandle<Result<Response, hmux_runtime_contract::RuntimeContractError>>>,
    stderr_reader: Option<JoinHandle<Result<Vec<u8>, std::io::Error>>>,
}

impl<Response> RuntimeBroker<Response>
where
    Response: DeserializeOwned + Send + 'static,
{
    pub(crate) fn spawn(
        command: &mut Command,
        label: &'static str,
        error_code: &'static str,
    ) -> Result<Self, ClientError> {
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| {
                runtime_error(
                    error_code,
                    format!("could not start {label} runtime: {error}"),
                )
            })?;
        let input = child.stdin.take().ok_or_else(|| {
            runtime_error(error_code, format!("{label} runtime stdin is unavailable"))
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            runtime_error(error_code, format!("{label} runtime stdout is unavailable"))
        })?;
        let stderr = child.stderr.take().ok_or_else(|| {
            runtime_error(error_code, format!("{label} runtime stderr is unavailable"))
        })?;
        let response_reader = thread::spawn(move || {
            let mut stdout = stdout;
            read_json_frame::<Response>(&mut stdout)
        });
        let stderr_reader = thread::spawn(move || read_bounded(stderr, MAX_STDERR_BYTES));
        Ok(Self {
            label,
            error_code,
            child: Some(child),
            input: Some(input),
            response_reader: Some(response_reader),
            stderr_reader: Some(stderr_reader),
        })
    }

    pub(crate) fn write(&mut self, value: &impl Serialize) -> Result<(), ClientError> {
        let input = self.input.as_mut().ok_or_else(|| {
            runtime_error(
                self.error_code,
                format!("{} runtime stdin is closed", self.label),
            )
        })?;
        write_json_frame(input, value).map_err(|error| {
            runtime_error(
                self.error_code,
                format!("could not write {} request: {error}", self.label),
            )
        })
    }

    pub(crate) fn close_input(&mut self) {
        self.input.take();
    }

    pub(crate) fn read_response(&mut self) -> Result<Response, ClientError> {
        // The runtime owns operation-specific deadlines. A journal or
        // maintenance fence may legitimately serialize this local child.
        let response = self.join_response();
        if response.is_ok() {
            return response;
        }
        match self.child_mut().wait() {
            Ok(status) if !status.success() => Err(self.exit_error(status)),
            Ok(_) => response,
            Err(error) => Err(self.terminate_with_message(format!(
                "could not wait for {} runtime: {error}",
                self.label
            ))),
        }
    }

    pub(crate) fn finish(mut self) -> Result<(), ClientError> {
        self.close_input();
        let status = match self.child_mut().wait() {
            Ok(status) => status,
            Err(error) => {
                return Err(self.terminate_with_message(format!(
                    "could not wait for {} runtime finalization: {error}",
                    self.label
                )));
            }
        };
        self.child.take();
        if let Some(reader) = self.response_reader.take() {
            let _ = reader.join();
        }
        if status.success() {
            self.join_stderr().map(|_| ()).map_err(|error| {
                runtime_error(
                    self.error_code,
                    format!("could not read {} runtime stderr: {error}", self.label),
                )
            })
        } else {
            Err(self.exit_error(status))
        }
    }

    fn child_mut(&mut self) -> &mut Child {
        self.child
            .as_mut()
            .expect("runtime broker child is available until finalization")
    }

    fn join_response(&mut self) -> Result<Response, ClientError> {
        self.response_reader
            .take()
            .expect("runtime broker response is read exactly once")
            .join()
            .map_err(|_| {
                runtime_error(
                    self.error_code,
                    format!("{} response reader panicked", self.label),
                )
            })?
            .map_err(|error| {
                runtime_error(
                    self.error_code,
                    format!("could not decode {} response: {error}", self.label),
                )
            })
    }

    fn exit_error(&mut self, status: ExitStatus) -> ClientError {
        let stderr = self
            .join_stderr()
            .unwrap_or_else(|error| format!("could not read runtime stderr: {error}").into_bytes());
        runtime_error(
            self.error_code,
            format!(
                "{} runtime exited with {status}: {}",
                self.label,
                String::from_utf8_lossy(&stderr).trim()
            ),
        )
    }

    fn join_stderr(&mut self) -> Result<Vec<u8>, std::io::Error> {
        self.stderr_reader
            .take()
            .map(|reader| {
                reader
                    .join()
                    .map_err(|_| std::io::Error::other("runtime stderr reader panicked"))?
            })
            .unwrap_or_else(|| Ok(Vec::new()))
    }

    fn terminate_with_message(&mut self, message: String) -> ClientError {
        self.close_input();
        if let Some(child) = self.child.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
        self.child.take();
        if let Some(reader) = self.response_reader.take() {
            let _ = reader.join();
        }
        let stderr = self.join_stderr().unwrap_or_default();
        let detail = String::from_utf8_lossy(&stderr);
        let detail = detail.trim();
        if detail.is_empty() {
            runtime_error(self.error_code, message)
        } else {
            runtime_error(self.error_code, format!("{message}: {detail}"))
        }
    }
}

impl<Response> Drop for RuntimeBroker<Response> {
    fn drop(&mut self) {
        self.input.take();
        if let Some(child) = self.child.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
        self.child.take();
        if let Some(reader) = self.response_reader.take() {
            let _ = reader.join();
        }
        if let Some(reader) = self.stderr_reader.take() {
            let _ = reader.join();
        }
    }
}

fn read_bounded(mut reader: impl Read, maximum: usize) -> Result<Vec<u8>, std::io::Error> {
    let mut retained = Vec::new();
    let mut buffer = [0_u8; 8192];
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            return Ok(retained);
        }
        let remaining = maximum.saturating_sub(retained.len());
        retained.extend_from_slice(&buffer[..count.min(remaining)]);
    }
}

fn runtime_error(code: &'static str, message: impl Into<String>) -> ClientError {
    ClientError::transport(code, message)
}
