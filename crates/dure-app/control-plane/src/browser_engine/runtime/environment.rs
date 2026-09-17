//! Chromium owns effective emulation; Host admits each mutation. Use the
//! resource-owned page session shared with observation and other actions.

use super::{BrowserActionPermit, BrowserCdp, BrowserRuntimeError, Execution};
use crate::browser_engine::{BrowserEngineError, NativeBrowserResponse};
use dure_app::BrowserProfileUserAgentModeV1;
use hmux_session_protocol::browser_resource::{BrowserDocumentId, BrowserPageIdentity};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;

mod device;

#[cfg(test)]
use super::BrowserRuntime;
#[cfg(test)]
mod tests;

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
enum Media {
    Screen,
    Print,
    Reset,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
enum ColorScheme {
    Light,
    Dark,
    NoPreference,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
enum ReducedMotion {
    Reduce,
    NoPreference,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum PermissionSetting {
    Granted,
    Denied,
    Prompt,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum Permission {
    Geolocation,
    #[serde(rename = "clipboard-read")]
    ClipboardRead,
    #[serde(rename = "clipboard-write")]
    ClipboardWrite,
}

fn default_scale() -> f64 {
    1.0
}

#[derive(Debug, Deserialize)]
#[serde(try_from = "EnvironmentAction")]
pub(super) struct BrowserEnvironmentAction(EnvironmentAction);

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum EnvironmentAction {
    Viewport {
        width: u32,
        height: u32,
        #[serde(default = "default_scale")]
        scale: f64,
        #[serde(default)]
        mobile: bool,
    },
    ViewportReset,
    Device {
        name: device::BrowserDevice,
    },
    DeviceReset {},
    Media {
        media: Option<Media>,
        color_scheme: Option<ColorScheme>,
        reduced_motion: Option<ReducedMotion>,
    },
    Geolocation {
        latitude: f64,
        longitude: f64,
        #[serde(default = "default_scale")]
        accuracy: f64,
    },
    GeolocationUnavailable,
    GeolocationReset,
    Offline {
        offline: bool,
    },
    Headers {
        headers: BTreeMap<String, String>,
    },
    Permission {
        permission: Permission,
        setting: PermissionSetting,
        origin: String,
    },
}

impl TryFrom<EnvironmentAction> for BrowserEnvironmentAction {
    type Error = &'static str;
    fn try_from(mut action: EnvironmentAction) -> Result<Self, Self::Error> {
        match &mut action {
            EnvironmentAction::Viewport {
                width,
                height,
                scale,
                ..
            } if !(1..=65_535).contains(width)
                || !(1..=65_535).contains(height)
                || !scale.is_finite()
                || !(0.1..=8.0).contains(scale)
                || f64::from(*width) * f64::from(*height) * *scale * *scale > 16_000_000.0 =>
            {
                return Err("browser_viewport_invalid");
            }
            EnvironmentAction::Media {
                media: Some(Media::Reset),
                color_scheme,
                reduced_motion,
            } if color_scheme.is_some() || reduced_motion.is_some() => {
                return Err("browser_media_invalid");
            }
            EnvironmentAction::Media {
                media: None,
                color_scheme: None,
                reduced_motion: None,
            } => return Err("browser_media_invalid"),
            EnvironmentAction::Geolocation {
                latitude,
                longitude,
                accuracy,
            } if !latitude.is_finite()
                || !(-90.0..=90.0).contains(latitude)
                || !longitude.is_finite()
                || !(-180.0..=180.0).contains(longitude)
                || !accuracy.is_finite()
                || *accuracy < 0.0 =>
            {
                return Err("browser_geolocation_invalid");
            }
            EnvironmentAction::Headers { headers } => {
                let mut normalized = BTreeMap::new();
                let mut bytes = 0;
                for (name, value) in std::mem::take(headers) {
                    bytes += name.len() + value.len();
                    if bytes > 64 * 1024 {
                        return Err("browser_headers_invalid");
                    }
                    let name = reqwest::header::HeaderName::from_bytes(name.as_bytes())
                        .map_err(|_| "browser_headers_invalid")?;
                    reqwest::header::HeaderValue::from_str(&value)
                        .map_err(|_| "browser_headers_invalid")?;
                    if normalized.insert(name.as_str().to_owned(), value).is_some() {
                        return Err("browser_headers_invalid");
                    }
                }
                *headers = normalized;
            }
            EnvironmentAction::Permission { origin, .. } => {
                if origin.len() > 8192 {
                    return Err("browser_permission_origin_invalid");
                }
                let url =
                    reqwest::Url::parse(origin).map_err(|_| "browser_permission_origin_invalid")?;
                if !matches!(url.scheme(), "http" | "https")
                    || url.host_str().is_none()
                    || !url.username().is_empty()
                    || url.password().is_some()
                    || url.path() != "/"
                    || url.query().is_some()
                    || url.fragment().is_some()
                {
                    return Err("browser_permission_origin_invalid");
                }
                *origin = url.origin().ascii_serialization();
            }
            _ => {}
        }
        Ok(Self(action))
    }
}

impl BrowserEnvironmentAction {
    pub(super) fn request_headers(&self) -> Option<&BTreeMap<String, String>> {
        match &self.0 {
            EnvironmentAction::Headers { headers } => Some(headers),
            _ => None,
        }
    }
    fn commands(
        &self,
        user_agent_mode: BrowserProfileUserAgentModeV1,
    ) -> Vec<(&'static str, Value)> {
        let command = match &self.0 {
            EnvironmentAction::Device { name } => return name.commands(user_agent_mode),
            EnvironmentAction::DeviceReset {} => {
                let mut commands = vec![("Emulation.clearDeviceMetricsOverride", json!({}))];
                if user_agent_mode == BrowserProfileUserAgentModeV1::Clean {
                    commands.push(("Emulation.setUserAgentOverride", json!({"userAgent":""})));
                }
                return commands;
            }
            EnvironmentAction::Geolocation {
                latitude,
                longitude,
                accuracy,
            } => (
                "Emulation.setGeolocationOverride",
                json!({"latitude":latitude,"longitude":longitude,"accuracy":accuracy}),
            ),
            EnvironmentAction::GeolocationUnavailable => {
                ("Emulation.setGeolocationOverride", json!({}))
            }
            EnvironmentAction::GeolocationReset => {
                ("Emulation.clearGeolocationOverride", json!({}))
            }
            EnvironmentAction::Offline { offline } => (
                "Network.emulateNetworkConditions",
                json!({"offline":offline,"latency":0,"downloadThroughput":-1,"uploadThroughput":-1}),
            ),
            // The Host and retained network owner handle this configuration.
            EnvironmentAction::Headers { .. } => return Vec::new(),
            EnvironmentAction::Permission {
                permission,
                setting,
                origin,
            } => (
                "Browser.setPermission",
                json!({"permission":{"name":permission},"setting":setting,"origin":origin}),
            ),
            EnvironmentAction::Viewport {
                width,
                height,
                scale,
                mobile,
            } => (
                "Emulation.setDeviceMetricsOverride",
                json!({"width":width,"height":height,"deviceScaleFactor":scale,"mobile":mobile}),
            ),
            EnvironmentAction::ViewportReset => ("Emulation.clearDeviceMetricsOverride", json!({})),
            EnvironmentAction::Media {
                media,
                color_scheme,
                reduced_motion,
            } => {
                let mut features = Vec::new();
                if let Some(scheme) = color_scheme {
                    features.push(json!({"name":"prefers-color-scheme","value":scheme}));
                }
                if let Some(motion) = reduced_motion {
                    features.push(json!({"name":"prefers-reduced-motion","value":motion}));
                }
                let mut params = json!({"features":features});
                if let Some(media) = media {
                    params["media"] = match media {
                        Media::Reset => json!(""),
                        media => json!(media),
                    };
                }
                ("Emulation.setEmulatedMedia", params)
            }
        };
        vec![command]
    }
}

impl Execution<'_> {
    pub(super) async fn configure_request_headers(
        &self,
        permit: &BrowserActionPermit,
        headers: &BTreeMap<String, String>,
    ) -> Result<NativeBrowserResponse, BrowserRuntimeError> {
        self.binding.events.synchronize_events().await?;
        let target = self
            .resource
            .host
            .lock()
            .await
            .configure_request_headers(permit, headers)?;
        self.binding
            .events
            .apply_interception(target)
            .await
            .map_err(BrowserEngineError::after)?;
        // Mutation receipts report the effect, never persist header secrets.
        Ok(NativeBrowserResponse {
            id: "browser-environment".into(),
            success: true,
            data: json!({"applied":true}),
            error: None,
        })
    }

    pub(super) async fn environment_action(
        &self,
        permit: &BrowserActionPermit,
        page: &BrowserPageIdentity,
        mut cdp: BrowserCdp,
        action: &BrowserEnvironmentAction,
    ) -> Result<NativeBrowserResponse, BrowserRuntimeError> {
        let target = self
            .resource
            .host
            .lock()
            .await
            .dispatch_target(permit)?
            .clone();
        let session = cdp.attach(target.as_str()).await?;
        if matches!(action.0, EnvironmentAction::Offline { .. }) {
            // Offline emulation needs the enabled Network agent. The retained
            // event owner applies request headers and owns network observation.
            cdp.request(
                "Network.enable",
                json!({"maxTotalBufferSize":0,"maxResourceBufferSize":0,"maxPostDataSize":0}),
                Some(&session),
            )
            .await?;
        }
        let browser_permission = matches!(action.0, EnvironmentAction::Permission { .. });
        let context = if browser_permission {
            Some(self.binding.events.storage_context(target.clone()).await?)
        } else {
            None
        };
        let mut applied = Vec::new();
        for (method, params) in action.commands(self.user_agent_mode) {
            // A metrics change can run resize handlers and navigate. Observe
            // the document before each step of this single admitted action.
            let target = async {
                let document = cdp.document(&session).await.map_err(|_| {
                    BrowserEngineError::after("browser_environment_session_unavailable")
                })?;
                let document =
                    BrowserDocumentId::new(document).map_err(|_| "browser_document_invalid")?;
                let mut host = self.resource.host.lock().await;
                host.document_committed(&page.page_id, document)?;
                host.dispatch_target(permit)?;
                Ok::<_, BrowserRuntimeError>(())
            }
            .await;
            target.map_err(|error| {
                if applied.is_empty() {
                    error
                } else {
                    BrowserEngineError::after("browser_environment_incomplete").into()
                }
            })?;
            let mut dispatch = params.clone();
            if let Some(context) = &context {
                context.apply(&mut dispatch);
            }
            match cdp
                .request(
                    method,
                    dispatch,
                    if browser_permission {
                        None
                    } else {
                        Some(&session)
                    },
                )
                .await
            {
                Ok(_) => applied.push(json!({"method":method,"params":params})),
                Err("browser_cdp_request_rejected") if applied.is_empty() => {
                    return Ok(NativeBrowserResponse {
                        id: "browser-environment".into(),
                        success: false,
                        data: json!({}),
                        error: Some("browser_environment_rejected".into()),
                    });
                }
                Err(_) => {
                    return Err(
                        BrowserEngineError::after("browser_environment_outcome_unknown").into(),
                    );
                }
            }
        }
        Ok(NativeBrowserResponse {
            id: "browser-environment".into(),
            success: true,
            data: json!({"applied":if applied.len() == 1 { applied[0]["params"].clone() } else { json!(applied) }}),
            error: None,
        })
    }
}
