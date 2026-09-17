//! Chromium retains initialization scripts on their exact Page session. Host
//! admits changes; handles fence removal without duplicating that registry.

use super::*;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};

const PREFIX: &str = "init:v1:";
const MAX_IDENTIFIER: usize = 4096;

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum BrowserInitScriptAction {
    Add {
        script: String,
    },
    Remove {
        identifier: BrowserInitScriptIdentifier,
    },
}

impl BrowserInitScriptAction {
    pub(super) fn validate(&self) -> Result<(), &'static str> {
        if matches!(self, Self::Add { script } if script.len() > 64 * 1024) {
            return Err("browser_script_too_large");
        }
        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[serde(try_from = "String")]
pub(super) struct BrowserInitScriptIdentifier(Registration);

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Registration {
    resource: BrowserResourceIdentity,
    page_id: BrowserPageId,
    instance: BrowserInstanceId,
    target: BrowserTargetId,
    session: String,
    native_id: String,
}

impl TryFrom<String> for BrowserInitScriptIdentifier {
    type Error = &'static str;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        if value.len() > MAX_IDENTIFIER {
            return Err("browser_init_script_identifier_invalid");
        }
        let encoded = value
            .strip_prefix(PREFIX)
            .ok_or("browser_init_script_identifier_invalid")?;
        let bytes = URL_SAFE_NO_PAD
            .decode(encoded)
            .map_err(|_| "browser_init_script_identifier_invalid")?;
        let registration: Registration =
            serde_json::from_slice(&bytes).map_err(|_| "browser_init_script_identifier_invalid")?;
        if !native_identifier(&registration.session) || !native_identifier(&registration.native_id)
        {
            return Err("browser_init_script_identifier_invalid");
        }
        Ok(Self(registration))
    }
}

fn native_identifier(value: &str) -> bool {
    !value.is_empty() && value.len() <= 160 && !value.chars().any(char::is_control)
}

impl Registration {
    fn encode(&self) -> Result<String, &'static str> {
        let bytes =
            serde_json::to_vec(self).map_err(|_| "browser_init_script_identifier_invalid")?;
        Ok(format!("{PREFIX}{}", URL_SAFE_NO_PAD.encode(bytes)))
    }
}

impl Execution<'_> {
    pub(super) async fn init_script_action(
        &self,
        permit: &BrowserActionPermit,
        page: &BrowserPageIdentity,
        action: &BrowserInitScriptAction,
    ) -> Result<NativeBrowserResponse, BrowserRuntimeError> {
        let (target, source) = {
            let mut host = self.resource.host.lock().await;
            let target = host.dispatch_target(permit)?.clone();
            let source = host
                .network()
                .page_source(&target)
                .ok_or("browser_page_source_missing")?;
            (target, source)
        };
        // Registration belongs to the existing lifecycle-enabled Page session,
        // which also owns navigation. A command-only attachment can acknowledge
        // registration without executing its scripts on future documents.
        let mut cdp = self.renderer_cdp(self.binding.events.cdp.clone(), target.clone());
        let session = source.as_str();
        if !native_identifier(session) {
            return Err("browser_init_script_session_invalid".into());
        }
        let instance = self.binding.events.instance();
        let (method, params) = match action {
            BrowserInitScriptAction::Add { script } => (
                "Page.addScriptToEvaluateOnNewDocument",
                json!({"source":script}),
            ),
            BrowserInitScriptAction::Remove { identifier } => {
                let registered = &identifier.0;
                // Document revision deliberately changes on reload while the
                // Page session and its registered scripts remain the same.
                if registered.resource != page.resource
                    || registered.page_id != page.page_id
                    || &registered.instance != instance
                    || registered.target != target
                    || registered.session != session
                {
                    return Err("browser_init_script_scope_mismatch".into());
                }
                (
                    "Page.removeScriptToEvaluateOnNewDocument",
                    json!({"identifier":registered.native_id}),
                )
            }
        };
        self.resource.host.lock().await.dispatch_target(permit)?;
        let result = cdp.request(method, params, Some(session)).await;
        let result = match result {
            Ok(result) => result,
            Err("browser_cdp_request_rejected") => {
                return Ok(NativeBrowserResponse {
                    id: "browser-init-script".into(),
                    success: false,
                    data: Value::Null,
                    error: Some("browser_init_script_rejected".into()),
                });
            }
            Err(_) => {
                return Err(
                    BrowserEngineError::after("browser_init_script_outcome_unknown").into(),
                );
            }
        };
        let data = match action {
            BrowserInitScriptAction::Add { .. } => {
                let native_id = result["identifier"]
                    .as_str()
                    .filter(|id| native_identifier(id))
                    .ok_or_else(|| {
                        BrowserEngineError::after("browser_init_script_identifier_missing")
                    })?;
                let registered = Registration {
                    resource: page.resource.clone(),
                    page_id: page.page_id.clone(),
                    instance: instance.clone(),
                    target,
                    session: session.to_owned(),
                    native_id: native_id.to_owned(),
                };
                let identifier = registered.encode().map_err(BrowserEngineError::after)?;
                json!({"added":true,"identifier":identifier})
            }
            BrowserInitScriptAction::Remove { identifier } => {
                json!({"removed":true,"identifier":identifier.0.encode().map_err(BrowserEngineError::after)?})
            }
        };
        Ok(NativeBrowserResponse {
            id: "browser-init-script".into(),
            success: true,
            data,
            error: None,
        })
    }
}

#[cfg(test)]
mod tests;
