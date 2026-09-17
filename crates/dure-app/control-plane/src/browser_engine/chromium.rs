//! The adapter owns Chromium separately from the command engine. An engine
//! reconnect can only address this exact browser; it cannot launch a replacement.

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::Duration;

use serde_json::json;
use tokio::time::{Instant, sleep};

use super::{BrowserEngineError, cdp::BrowserCdp};
use hmux_session_protocol::browser_resource::{BrowserInstanceId, BrowserTargetId};

mod output;
pub(super) mod profile;
#[cfg(test)]
mod tests;

/// Issued only by the process owner. A worker may connect to this exact browser
/// generation but receives no child handle or browser retirement authority.
#[derive(Clone)]
pub(super) struct ChromiumConnection {
    endpoint: String,
    instance: BrowserInstanceId,
}

impl ChromiumConnection {
    pub(super) fn instance(&self) -> &BrowserInstanceId {
        &self.instance
    }

    pub(super) fn endpoint(&self) -> &str {
        &self.endpoint
    }
}

pub(super) struct OwnedChromium {
    child: Option<Child>,
    output: Option<output::StartupOutput>,
    announced: Option<tokio::sync::oneshot::Receiver<Result<String, BrowserEngineError>>>,
    profile: Option<profile::ProfileClaim>,
    connection: ChromiumConnection,
    root: PathBuf,
    exit_status: Option<ExitStatus>,
}

impl OwnedChromium {
    #[cfg(test)]
    pub(super) async fn launch(executable: &Path, root: &Path) -> Result<Self, BrowserEngineError> {
        Self::launch_selected(executable, root, None).await
    }

    #[cfg(test)]
    pub(super) async fn launch_profile(
        executable: &Path,
        root: &Path,
        profile: &dure_app::BrowserProfileIdV1,
    ) -> Result<Self, BrowserEngineError> {
        Self::launch_selected(executable, root, Some(profile)).await
    }

    #[cfg(test)]
    async fn launch_selected(
        executable: &Path,
        directory: &Path,
        selected: Option<&dure_app::BrowserProfileIdV1>,
    ) -> Result<Self, BrowserEngineError> {
        let instance = Self::new_instance_id()?;
        let mut browser = Self::spawn(executable, directory, selected, instance)?;
        if let Err(error) = browser.wait_ready().await {
            if browser.exit_status.is_none()
                && matches!(
                    browser.child.as_mut().expect("owned child").try_wait(),
                    Ok(None)
                )
            {
                let _ = browser.child.as_mut().expect("owned child").kill();
            }
            let _ = browser.wait_for_exit().await;
            return Err(error);
        }
        Ok(browser)
    }

    pub(super) fn new_instance_id() -> Result<BrowserInstanceId, BrowserEngineError> {
        let instance =
            BrowserInstanceId::new(crate::random_generation().map_err(|_| {
                BrowserEngineError::before("browser_instance_identity_unavailable")
            })?)
            .expect("bounded random browser instance identity");
        Ok(instance)
    }

    pub(super) fn spawn(
        executable: &Path,
        directory: &Path,
        selected: Option<&dure_app::BrowserProfileIdV1>,
        instance: BrowserInstanceId,
    ) -> Result<Self, BrowserEngineError> {
        let mut claim = selected
            .map(|id| profile::ProfileClaim::acquire(directory, id, &instance))
            .transpose()?;
        let directory = tempfile::Builder::new()
            .prefix("browser-profile-")
            .tempdir_in(directory)
            .map_err(|_| BrowserEngineError::before("browser_chromium_profile_unavailable"))?;
        fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700))
            .map_err(|_| BrowserEngineError::before("browser_chromium_profile_unavailable"))?;
        let root = directory.keep();
        let profile = claim
            .as_ref()
            .map(|claim| claim.profile.clone())
            .unwrap_or_else(|| root.join("profile"));
        let downloads = root.join("downloads");
        fs::create_dir(&downloads)
            .and_then(|_| fs::set_permissions(&downloads, fs::Permissions::from_mode(0o700)))
            .map_err(|_| BrowserEngineError::before("browser_chromium_profile_unavailable"))?;
        if claim.is_none() {
            // Temporary profiles retain their ordinary private download path.
            // Persistent profiles initialize a stable private fallback once;
            // managed downloads always use this launch's separate scratch path.
            let preferences = profile.join("Default/Preferences");
            fs::create_dir_all(preferences.parent().expect("profile parent"))
                .and_then(|_|fs::write(&preferences, json!({"download":{"default_directory":downloads,"prompt_for_download":false}}).to_string()))
                .and_then(|_|fs::set_permissions(&preferences, fs::Permissions::from_mode(0o600)))
                .map_err(|_|BrowserEngineError::before("browser_chromium_profile_unavailable"))?;
        }
        let child = Command::new(executable)
            .current_dir(&root)
            .env_clear()
            .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
            .env("LANG", "en_US.UTF-8")
            .env("TMPDIR", &root)
            .arg("--headless=new")
            .arg("--remote-debugging-address=127.0.0.1")
            .arg("--remote-debugging-port=0")
            .arg(format!("--user-data-dir={}", profile.display()))
            .arg("--window-size=1280,720")
            // Owned headless pages receive input without a visible OS window.
            // Occlusion must not suspend their renderer's input acknowledgements.
            .arg("--disable-backgrounding-occluded-windows")
            .args([
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-background-networking",
                "--disable-extensions",
                "--disable-sync",
                "--password-store=basic",
                "--use-mock-keychain",
            ])
            .arg("about:blank")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|_| BrowserEngineError::before("browser_chromium_spawn_failed"))?;
        if let Some(claim) = &mut claim {
            claim.started();
        }
        let browser = Self {
            child: Some(child),
            output: None,
            announced: None,
            profile: claim,
            connection: ChromiumConnection {
                endpoint: String::new(),
                instance,
            },
            root,
            exit_status: None,
        };
        Ok(browser)
    }

    pub(super) async fn wait_ready(&mut self) -> Result<(), BrowserEngineError> {
        if !self.connection.endpoint.is_empty() {
            return Ok(());
        }
        if self.announced.is_none() {
            let stderr = self
                .child
                .as_mut()
                .expect("owned child")
                .stderr
                .take()
                .ok_or_else(|| BrowserEngineError::before("browser_chromium_output_unavailable"))?;
            let (output, announced) = output::StartupOutput::start(stderr)?;
            self.output = Some(output);
            self.announced = Some(announced);
        }
        let announced = self
            .announced
            .as_mut()
            .ok_or_else(|| BrowserEngineError::before("browser_chromium_output_unavailable"))?;
        // A canceled waiter leaves the endpoint receiver with the native owner.
        let announced = tokio::time::timeout(Duration::from_secs(10), announced)
            .await
            .map_err(|_| BrowserEngineError::before("browser_chromium_startup_timeout"))?;
        self.announced.take();
        let endpoint = announced
            .map_err(|_| BrowserEngineError::before("browser_chromium_output_unavailable"))??;
        if self.has_exited()? {
            return Err(BrowserEngineError::before(
                "browser_chromium_startup_failed",
            ));
        }
        self.connection.endpoint = endpoint;
        Ok(())
    }

    pub(super) fn endpoint(&self) -> &str {
        self.connection.endpoint()
    }

    pub(super) fn connection(&self) -> ChromiumConnection {
        self.connection.clone()
    }

    #[cfg(test)]
    pub(super) fn replace_test_endpoint(&mut self, endpoint: String) -> String {
        std::mem::replace(&mut self.connection.endpoint, endpoint)
    }

    pub(super) fn download_directory(&self) -> PathBuf {
        self.root.join("downloads")
    }

    /// Before a runtime observer exists, the process owner creates its blank
    /// launch page. Later user page creation uses the admitted event source.
    pub(super) async fn launch_page(&self) -> Result<BrowserTargetId, BrowserEngineError> {
        let mut cdp = BrowserCdp::connect(self.endpoint())
            .await
            .map_err(BrowserEngineError::before)?;
        let created = cdp
            .request("Target.createTarget", json!({"url":"about:blank"}), None)
            .await;
        cdp.retire().await;
        let created = created.map_err(BrowserEngineError::after)?;
        BrowserTargetId::new(
            created["targetId"]
                .as_str()
                .ok_or_else(|| BrowserEngineError::after("browser_launch_target_missing"))?,
        )
        .map_err(|_| BrowserEngineError::after("browser_launch_target_invalid"))
    }

    pub(super) fn has_exited(&mut self) -> Result<bool, BrowserEngineError> {
        if self.exit_status.is_none() {
            self.exit_status = self
                .child
                .as_mut()
                .expect("owned child")
                .try_wait()
                .map_err(|_| BrowserEngineError::after("browser_chromium_process_unconfirmed"))?;
        }
        Ok(self.exit_status.is_some())
    }

    async fn wait_for_exit(&mut self) -> Result<(), BrowserEngineError> {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if self.has_exited()? {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(BrowserEngineError::after(
                    "browser_chromium_retirement_unconfirmed",
                ));
            }
            sleep(Duration::from_millis(25)).await;
        }
    }

    pub(super) async fn close(&mut self) -> Result<(), BrowserEngineError> {
        if self.has_exited()? {
            return self.release_profile().await;
        }
        self.wait_ready().await?;
        let connection = BrowserCdp::connect(self.endpoint()).await;
        #[cfg(test)]
        if let Err(error) = &connection {
            eprintln!("BROWSER_CHROMIUM_CLOSE_CONNECT error={error}");
        }
        if let Ok(mut cdp) = connection {
            let response = cdp.request("Browser.close", json!({}), None).await;
            #[cfg(test)]
            eprintln!("BROWSER_CHROMIUM_CLOSE_REQUEST response={response:?}");
            let _ = response;
        }
        // A lost close response is resolved by waiting on our own child handle.
        // No PID-file lookup, name-based kill, or new browser is involved.
        self.wait_for_exit().await?;
        self.release_profile().await
    }

    pub(super) fn profile_id(&self) -> Option<&dure_app::BrowserProfileIdV1> {
        self.profile.as_ref().map(|claim| &claim.id)
    }

    async fn release_profile(&mut self) -> Result<(), BrowserEngineError> {
        if let Some(output) = self.output.take() {
            output.close().await;
        }
        if let Some(claim) = &mut self.profile {
            if !self.exit_status.is_some_and(|status| status.success()) {
                // Keep the process owner's actual result in backend diagnostics.
                // It explains the refusal; it never authorizes profile reuse.
                eprintln!(
                    "browser profile retirement remains unconfirmed: profile={} instance={} child={} status={:?}",
                    claim.id.as_str(),
                    self.connection.instance().as_str(),
                    self.child.as_ref().expect("owned child").id(),
                    self.exit_status
                );
                return Err(BrowserEngineError::after(
                    "browser_profile_exit_unconfirmed",
                ));
            }
            claim.release_after_exit()?;
        }
        Ok(())
    }
}

impl Drop for OwnedChromium {
    fn drop(&mut self) {
        let Some(mut child) = self.child.take() else {
            return;
        };
        let mut claim = self.profile.take();
        self.output.take();
        let status = self.exit_status.or_else(|| child.try_wait().ok().flatten());
        if let Some(status) = status {
            if status.success()
                && let Some(claim) = &mut claim
            {
                let _ = claim.release_after_exit();
            }
            return;
        }
        // A canceled launch keeps its exact child and storage claim together
        // until wait confirms exit, including outside an active Tokio runtime.
        let _ = std::thread::Builder::new()
            .name("browser-retirement".into())
            .spawn(move || {
                let _ = child.kill();
                let _ = child.wait();
                // A forced parent exit does not prove every Chromium storage
                // writer retired normally. Keep the durable claim unavailable.
                drop(claim);
            });
    }
}
