//! A download is one admitted click followed by observation of its page and
//! download GUID. Files never authorize replay or become client-chosen paths.

use super::capture::MAX_ARTIFACT_BYTES;
use super::find::FindAction;
use super::{
    BrowserActionPermit, BrowserCdp, BrowserElementTarget, BrowserRuntimeError, Execution,
};
use crate::browser_engine::{BrowserEngineError, NativeBrowserEngine, NativeBrowserResponse};
use base64::{Engine, engine::general_purpose::STANDARD};
use hmux_session_protocol::browser_resource::BrowserPageIdentity;
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use tokio::io::AsyncReadExt;
use tokio::time::{Duration, Instant, sleep, timeout};

#[cfg(test)]
use super::BrowserRuntime;
#[cfg(test)]
mod tests;

pub(super) fn default_timeout() -> u32 {
    30_000
}

pub(super) struct DownloadState {
    directory: PathBuf,
    cdp: BrowserCdp,
}

impl DownloadState {
    pub(super) async fn close(&mut self) -> Result<(), &'static str> {
        self.cdp.retire().await;
        match tokio::fs::remove_dir_all(&self.directory).await {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err("browser_download_storage_unavailable"),
        }
    }
}

pub(super) async fn prepare(
    browser: &crate::browser_engine::chromium::OwnedChromium,
) -> Result<DownloadState, &'static str> {
    let directory = browser.download_directory();
    let mut cdp = BrowserCdp::connect(browser.endpoint()).await?;
    cdp.retain_events().await;
    deny(&mut cdp).await?;
    Ok(DownloadState { directory, cdp })
}

async fn deny(cdp: &mut BrowserCdp) -> Result<(), &'static str> {
    cdp.request(
        "Browser.setDownloadBehavior",
        json!({"behavior":"deny","eventsEnabled":false}),
        None,
    )
    .await?;
    Ok(())
}

fn guid(event: &Value) -> Result<String, &'static str> {
    event["params"]["guid"]
        .as_str()
        .filter(|id| {
            !id.is_empty()
                && id.len() <= 128
                && id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
        .map(String::from)
        .ok_or("browser_download_identity_invalid")
}

async fn cancel(cdp: &mut BrowserCdp, id: &str) -> Result<(), &'static str> {
    cdp.request("Browser.cancelDownload", json!({"guid":id}), None)
        .await?;
    Ok(())
}

impl Execution<'_> {
    pub(super) async fn download_action(
        &self,
        engine: &mut NativeBrowserEngine,
        permit: &BrowserActionPermit,
        page: &BrowserPageIdentity,
        cdp: BrowserCdp,
        (target, timeout_ms): (&BrowserElementTarget, u32),
    ) -> Result<NativeBrowserResponse, BrowserRuntimeError> {
        let binding = self
            .resource
            .host
            .lock()
            .await
            .dispatch_target(permit)?
            .clone();
        let mut downloads = self.binding.downloads.lock().await;
        let DownloadState {
            directory,
            cdp: events,
        } = downloads.as_mut().ok_or("browser_resource_retiring")?;
        // This connection belongs to the browser instance. A resource-local
        // census must not detach another resource's retained download session.
        let census = events.request("Target.getTargets", json!({}), None).await?;
        let live = census["targetInfos"]
            .as_array()
            .ok_or("browser_download_census_invalid")?
            .iter()
            .map(|info| {
                info["targetId"]
                    .as_str()
                    .ok_or("browser_download_census_invalid")
            })
            .collect::<Result<Vec<_>, _>>()?;
        events.retain_targets(&live).await;
        storage_headroom(directory).await?;
        let mut element = target.resolve(cdp, binding.as_str()).await?;
        // A lost reply can leave an attachment on this persistent connection
        // without its retirement handle. Only resource close can resolve it.
        let session = events
            .attach(binding.as_str())
            .await
            .map_err(|_| BrowserEngineError::after("browser_download_attachment_unconfirmed"))?;
        let mut pending = BTreeSet::new();
        let mut detached = false;
        let result: Result<_, BrowserRuntimeError> = async {
            events.request("Page.enable", json!({}), Some(&session)).await?;
            let tree = events.request("Page.getFrameTree", json!({}), Some(&session)).await?;
            let frame = tree["frameTree"]["frame"]["id"].as_str().ok_or("browser_download_page_missing")?;
            let loader = tree["frameTree"]["frame"]["loaderId"].as_str().ok_or("browser_download_page_missing")?;
            self.validate_find(engine, permit, &mut element).await?;
            // The directory remains resource-owned even if observation or cleanup
            // becomes uncertain. Only confirmed engine retirement removes it.
            while events.pop_event().await.is_some() {}
            events.request(
                "Browser.setDownloadBehavior",
                json!({"behavior":"allowAndName","downloadPath":directory,"eventsEnabled":true}),
                None,
            ).await?;
            let clicked = self.act_on_element(engine, permit, &mut element, &FindAction::Click).await?;
            if !clicked.success { return Ok(clicked); }
            let completed = timeout(Duration::from_millis(u64::from(timeout_ms)), wait_for_file(events, &session, frame, loader, &mut pending, &mut detached)).await;
            let (id, name, size) = match completed {
                Ok(Ok(file)) => file,
                Ok(Err(code)) => return Ok(failed(code)),
                Err(_) => return Ok(failed("browser_download_timeout")),
            };
            let bytes = match read_file(directory, &id, size).await {
                Ok(bytes) => bytes,
                Err(code) => return Ok(failed(code)),
            };
            Ok(NativeBrowserResponse {
                id: "browser-download".into(), success: true, error: None,
                data: json!({"artifact_payload":{"page":page,"mime_type":"application/octet-stream","suggested_filename":name,"base64":STANDARD.encode(bytes)}}),
            })
        }.await;
        // The page event session is cached until its target closes. Detaching
        // an observer would clear Chromium's media override on that page.
        // Restore policy on success, timeout and known target failure alike.
        // An uncertain restoration fences the Host; it cannot admit new input.
        let cleanup = timeout(Duration::from_secs(5), async {
            deny(events).await?;
            while let Some(event) = events.pop_event().await {
                if event["method"] == "Target.detachedFromTarget"
                    && event["params"]["sessionId"] == session
                {
                    detached = true;
                }
                if event["method"] == "Browser.downloadWillBegin" {
                    pending.insert(guid(&event)?);
                }
                if pending.len() > 128 {
                    return Err("browser_download_event_limit");
                }
            }
            for id in pending {
                cancel(events, &id).await?;
            }
            if !detached {
                events
                    .request("Page.disable", json!({}), Some(&session))
                    .await?;
            }
            Ok::<_, &'static str>(())
        })
        .await;
        if !matches!(cleanup, Ok(Ok(()))) {
            return Err(
                BrowserEngineError::after("browser_download_retirement_unconfirmed").into(),
            );
        }
        result
    }
}

fn failed(code: &'static str) -> NativeBrowserResponse {
    NativeBrowserResponse {
        id: "browser-download".into(),
        success: false,
        data: json!({}),
        error: Some(code.into()),
    }
}

async fn wait_for_file(
    cdp: &mut BrowserCdp,
    session: &str,
    frame: &str,
    loader: &str,
    pending: &mut BTreeSet<String>,
    detached: &mut bool,
) -> Result<(String, String, u64), &'static str> {
    let mut selected: Option<(String, String)> = None;
    loop {
        let event = cdp.next_event().await?;
        let params = &event["params"];
        if event["method"] == "Target.detachedFromTarget" && params["sessionId"] == session {
            *detached = true;
            return Err("browser_download_page_closed");
        }
        if event["method"] == "Page.frameNavigated"
            && event["sessionId"] == session
            && params["frame"]["id"] == frame
            && params["frame"]["loaderId"] != loader
        {
            return Err("browser_download_document_changed");
        }
        if event["method"] == "Browser.downloadWillBegin" {
            let id = guid(&event)?;
            pending.insert(id.clone());
            if pending.len() > 128 {
                return Err("browser_download_event_limit");
            }
            if selected.is_none() && params["frameId"] == frame {
                let name = params["suggestedFilename"]
                    .as_str()
                    .filter(|name| name.len() <= 4096)
                    .ok_or("browser_download_name_invalid")?
                    .to_owned();
                selected = Some((id, name));
            } else {
                cancel(cdp, &id).await?;
            }
        } else if event["method"] == "Browser.downloadProgress" {
            let id = guid(&event)?;
            if params["state"] == "completed" || params["state"] == "canceled" {
                pending.remove(&id);
            }
            let Some((selected_id, name)) = &selected else {
                continue;
            };
            if selected_id != &id {
                continue;
            }
            let size = params["receivedBytes"]
                .as_f64()
                .filter(|size| size.is_finite() && *size >= 0.0 && size.fract() == 0.0)
                .ok_or("browser_download_progress_invalid")?;
            let total = params["totalBytes"]
                .as_f64()
                .filter(|size| size.is_finite() && *size >= 0.0)
                .ok_or("browser_download_progress_invalid")?;
            if size > MAX_ARTIFACT_BYTES as f64 || total > MAX_ARTIFACT_BYTES as f64 {
                return Err("browser_download_byte_limit");
            }
            match params["state"].as_str() {
                Some("completed") => return Ok((id, name.clone(), size as u64)),
                Some("canceled") => return Err("browser_download_canceled"),
                Some("inProgress") => {}
                _ => return Err("browser_download_progress_invalid"),
            }
        }
    }
}

async fn storage_headroom(directory: &Path) -> Result<(), &'static str> {
    let mut entries = tokio::fs::read_dir(directory)
        .await
        .map_err(|_| "browser_download_storage_unavailable")?;
    let mut count = 0;
    let mut bytes = 0_u64;
    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|_| "browser_download_storage_unavailable")?
    {
        count += 1;
        bytes = bytes.saturating_add(
            entry
                .metadata()
                .await
                .map_err(|_| "browser_download_storage_unavailable")?
                .len(),
        );
        if count >= 128 || bytes > 3 * MAX_ARTIFACT_BYTES as u64 {
            return Err("browser_download_resource_limit");
        }
    }
    Ok(())
}

async fn read_file(directory: &Path, id: &str, size: u64) -> Result<Vec<u8>, &'static str> {
    let path = directory.join(id);
    let deadline = Instant::now() + Duration::from_secs(2);
    let file = loop {
        match tokio::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(&path)
            .await
        {
            Ok(file) => break file,
            Err(error)
                if error.kind() == std::io::ErrorKind::NotFound && Instant::now() < deadline =>
            {
                sleep(Duration::from_millis(25)).await
            }
            Err(_) => return Err("browser_download_file_unavailable"),
        }
    };
    let metadata = file
        .metadata()
        .await
        .map_err(|_| "browser_download_file_unavailable")?;
    if !metadata.is_file() || metadata.len() != size || size > MAX_ARTIFACT_BYTES as u64 {
        return Err("browser_download_file_invalid");
    }
    let mut bytes = Vec::with_capacity(size as usize);
    file.take(MAX_ARTIFACT_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| "browser_download_file_unavailable")?;
    if bytes.len() as u64 != size {
        return Err("browser_download_file_changed");
    }
    Ok(bytes)
}
