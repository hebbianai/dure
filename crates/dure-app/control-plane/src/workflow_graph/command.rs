use std::collections::BTreeMap;
use std::process::Stdio;

use agent_orchestration::domain::graph::ActionValues;
use serde_json::json;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};

const MAX_STREAM_BYTES: u64 = 16 * 1024;

pub(super) struct ActionFailure {
    pub code: &'static str,
    pub uncertain: bool,
    pub outputs: Option<ActionValues>,
}

/// A process group created by this invocation, retained only for the lifetime of
/// its Child. It contains no caller-supplied PID or discovered process identity.
struct OwnedCommandGroup(u32);

impl Drop for OwnedCommandGroup {
    fn drop(&mut self) {
        if let Ok(pid) = i32::try_from(self.0) {
            // SAFETY: process_group(0) creates this owned group at spawn. Kill
            // outstanding descendants when the command finishes or is canceled.
            unsafe {
                libc::kill(-pid, libc::SIGKILL);
            }
        }
    }
}

pub(super) async fn execute(
    inputs: &ActionValues,
    directory: &std::path::Path,
) -> Result<ActionValues, ActionFailure> {
    let text = |field: &str| inputs.get(field).and_then(serde_json::Value::as_str);
    let script = text("script").ok_or(failure("command_script_invalid", false))?;
    let input = text("stdin").unwrap_or_default();
    let seconds = inputs
        .get("timeoutSeconds")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(60);
    let mut command = tokio::process::Command::new("/bin/sh");
    command
        .arg("-c")
        .arg(script)
        .current_dir(directory)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .map_err(|_| failure("command_spawn_failed", false))?;
    let group = OwnedCommandGroup(
        child
            .id()
            .ok_or(failure("command_identity_unavailable", true))?,
    );
    let mut stdin = child
        .stdin
        .take()
        .ok_or(failure("command_pipe_unavailable", true))?;
    let stdout = child
        .stdout
        .take()
        .ok_or(failure("command_pipe_unavailable", true))?;
    let stderr = child
        .stderr
        .take()
        .ok_or(failure("command_pipe_unavailable", true))?;
    let observed = tokio::time::timeout(std::time::Duration::from_secs(seconds), async {
        let input = async move {
            // Field mappings are data on stdin. They are never interpolated into
            // shell source, arguments, environment, or a working directory.
            stdin
                .write_all(input.as_bytes())
                .await
                .map_err(|_| failure("command_input_failed", true))?;
            stdin
                .shutdown()
                .await
                .map_err(|_| failure("command_input_failed", true))?;
            drop(stdin);
            Ok::<(), ActionFailure>(())
        };
        let status = async {
            child
                .wait()
                .await
                .map_err(|_| failure("command_result_unavailable", true))
        };
        tokio::try_join!(
            input,
            bounded_output(stdout),
            bounded_output(stderr),
            status
        )
    })
    .await;
    drop(group);
    let _ = child.start_kill();
    let _ = child.wait().await;
    let (_, stdout, stderr, status) =
        observed.map_err(|_| failure("command_timed_out", true))??;
    let code = status.code().ok_or(failure("command_interrupted", true))?;
    let outputs = BTreeMap::from([
        ("stdout".into(), json!(stdout)),
        ("stderr".into(), json!(stderr)),
        ("exitCode".into(), json!(code)),
        ("directory".into(), json!(directory)),
    ]);
    if code != 0 {
        return Err(ActionFailure {
            code: "command_exit_failed",
            uncertain: false,
            outputs: Some(outputs),
        });
    }
    Ok(outputs)
}

async fn bounded_output(stream: impl AsyncRead + Unpin) -> Result<String, ActionFailure> {
    let mut bytes = Vec::new();
    stream
        .take(MAX_STREAM_BYTES + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| failure("command_output_unavailable", true))?;
    if bytes.len() > MAX_STREAM_BYTES as usize {
        return Err(failure("command_output_too_large", true));
    }
    String::from_utf8(bytes).map_err(|_| failure("command_output_not_utf8", false))
}

fn failure(code: &'static str, uncertain: bool) -> ActionFailure {
    ActionFailure {
        code,
        uncertain,
        outputs: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn workflow_graph_command_receives_mapping_as_data_and_observes_real_output() {
        let root = tempfile::tempdir().unwrap();
        let inputs = BTreeMap::from([
            ("script".into(), json!("cat; printf 'diagnostic' >&2")),
            ("directory".into(), json!(root.path())),
            ("stdin".into(), json!("$(touch injected)\n; exit 99")),
        ]);
        let output = execute(&inputs, root.path())
            .await
            .unwrap_or_else(|failure| panic!("{}", failure.code));
        assert_eq!(output["stdout"], inputs["stdin"]);
        assert_eq!(output["stderr"], "diagnostic");
        assert_eq!(output["exitCode"], 0);
        assert!(!root.path().join("injected").exists());
    }

    #[tokio::test]
    async fn workflow_graph_command_bounds_output_and_stops_on_timeout() {
        let root = tempfile::tempdir().unwrap();
        let mut inputs = BTreeMap::from([
            ("script".into(), json!("yes output")),
            ("directory".into(), json!(root.path())),
            ("timeoutSeconds".into(), json!(1)),
        ]);
        assert_eq!(
            execute(&inputs, root.path()).await.err().unwrap().code,
            "command_output_too_large"
        );
        inputs.insert("script".into(), json!("sleep 30"));
        assert_eq!(
            execute(&inputs, root.path()).await.err().unwrap().code,
            "command_timed_out"
        );
    }
}
