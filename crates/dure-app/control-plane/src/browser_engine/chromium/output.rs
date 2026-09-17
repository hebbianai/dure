//! Chromium announces its browser endpoint on the exact launched child's stderr.
//! The profile's DevToolsActivePort file is not startup authority.
use super::*;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::sync::oneshot;

pub(super) struct StartupOutput(tokio::task::JoinHandle<()>);

impl StartupOutput {
    pub(super) fn start(
        stderr: std::process::ChildStderr,
    ) -> Result<(Self, oneshot::Receiver<Result<String, BrowserEngineError>>), BrowserEngineError>
    {
        let stderr = tokio::process::ChildStderr::from_std(stderr)
            .map_err(|_| BrowserEngineError::before("browser_chromium_output_unavailable"))?;
        let (sender, receiver) = oneshot::channel();
        let task = tokio::spawn(async move {
            let mut reader = BufReader::new(stderr);
            let result = endpoint(&mut reader).await;
            let _ = sender.send(result);
            // Keep draining after announcement so normal diagnostics cannot
            // block the child. Neither page output nor diagnostics are retained.
            let _ = tokio::io::copy(&mut reader, &mut tokio::io::sink()).await;
        });
        Ok((Self(task), receiver))
    }

    pub(super) async fn close(self) {
        self.0.abort();
        // Await cancellation through a borrowed handle because Drop also aborts.
        let mut this = self;
        let _ = (&mut this.0).await;
    }
}

impl Drop for StartupOutput {
    fn drop(&mut self) {
        self.0.abort();
    }
}

async fn endpoint<R: tokio::io::AsyncBufRead + Unpin>(
    reader: &mut R,
) -> Result<String, BrowserEngineError> {
    loop {
        let mut line = Vec::new();
        let count = (&mut *reader)
            .take(4097)
            .read_until(b'\n', &mut line)
            .await
            .map_err(|_| BrowserEngineError::before("browser_chromium_output_unavailable"))?;
        if count == 0 || line.len() > 4096 {
            return Err(BrowserEngineError::before(
                "browser_chromium_startup_failed",
            ));
        }
        let Ok(line) = std::str::from_utf8(&line) else {
            continue;
        };
        if let Some(endpoint) = line
            .trim_end_matches(['\r', '\n'])
            .strip_prefix("DevTools listening on ")
        {
            if valid_endpoint(endpoint) {
                return Ok(endpoint.to_owned());
            }
            return Err(BrowserEngineError::before(
                "browser_chromium_endpoint_invalid",
            ));
        }
    }
}

fn valid_endpoint(value: &str) -> bool {
    let Some((port, identity)) = value
        .strip_prefix("ws://127.0.0.1:")
        .and_then(|value| value.split_once("/devtools/browser/"))
    else {
        return false;
    };
    port.parse::<u16>().is_ok_and(|port| port != 0)
        && !identity.is_empty()
        && identity.len() <= 256
        && identity
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}
