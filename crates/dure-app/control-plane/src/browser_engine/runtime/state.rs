//! Portable state files are data; native targets and continuations stay Host-owned.

mod encryption;
mod save;
pub(super) use encryption::BrowserStateKey;

use super::{BrowserActionPermit, BrowserCdp, BrowserRuntimeError, BrowserUploadId, Execution};
use crate::browser_engine::{
    BrowserEngineError, ENGINE_DEADLINE, NativeBrowserEngine, NativeBrowserResponse,
};
use hmux_session_protocol::browser_resource::BrowserDocumentId;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct StorageState {
    cookies: Vec<Value>,
    origins: Vec<OriginStorage>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OriginStorage {
    origin: String,
    local_storage: Vec<StorageEntry>,
    #[serde(default)]
    session_storage: Vec<StorageEntry>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct StorageEntry {
    name: String,
    value: String,
}

impl StorageState {
    fn parse(bytes: &[u8]) -> Result<Self, &'static str> {
        let mut state: Self =
            serde_json::from_slice(bytes).map_err(|_| "browser_state_file_invalid")?;
        // Validate the entire file before the first cookie or storage mutation.
        for origin in &mut state.origins {
            let url = Url::parse(&origin.origin).map_err(|_| "browser_state_origin_invalid")?;
            if !matches!(url.scheme(), "http" | "https")
                || url.host_str().is_none()
                || !url.username().is_empty()
                || url.password().is_some()
                || !matches!(url.path(), "" | "/")
                || url.query().is_some()
                || url.fragment().is_some()
                || origin.origin.len() > 8192
            {
                return Err("browser_state_origin_invalid");
            }
            origin.origin = url.origin().ascii_serialization();
        }
        for cookie in &mut state.cookies {
            let fields = cookie
                .as_object_mut()
                .ok_or("browser_state_cookie_invalid")?;
            // agent-browser exports these two read-only Network.Cookie fields.
            if fields
                .remove("size")
                .is_some_and(|value| value.as_i64().is_none())
                || fields
                    .remove("session")
                    .is_some_and(|value| !value.is_boolean())
                || !fields.get("domain").is_some_and(Value::is_string)
                || !fields.get("path").is_some_and(Value::is_string)
                || fields.contains_key("url")
            {
                return Err("browser_state_cookie_invalid");
            }
            let parsed: super::data::Cookie = serde_json::from_value(cookie.clone())
                .map_err(|_| "browser_state_cookie_invalid")?;
            parsed
                .validate(true)
                .map_err(|_| "browser_state_cookie_invalid")?;
        }
        Ok(state)
    }
}

fn response(error: Option<&str>, origins: usize, cookies: usize) -> NativeBrowserResponse {
    NativeBrowserResponse {
        id: "browser-state-load".into(),
        success: error.is_none(),
        error: error.map(String::from),
        data: json!({"loaded":error.is_none(),"origins_loaded":origins,"cookies_loaded":cookies,"partial":error.is_some()}),
    }
}

impl Execution<'_> {
    pub(super) async fn load_state(
        &self,
        engine: &mut NativeBrowserEngine,
        permit: &mut BrowserActionPermit,
        mut cdp: BrowserCdp,
        file: &BrowserUploadId,
        encryption_key: Option<&BrowserStateKey>,
    ) -> Result<NativeBrowserResponse, BrowserRuntimeError> {
        let bytes = self.resource.uploads.lock().await.read_sealed(file).await?;
        let bytes = match encryption_key {
            Some(key) => key.decrypt(&bytes)?,
            None => bytes,
        };
        let state = StorageState::parse(&bytes)?;
        let target = self
            .resource
            .host
            .lock()
            .await
            .dispatch_target(permit)?
            .clone();
        let session = cdp.attach(target.as_str()).await?;
        self.observe_engine(engine).await?;
        self.resource.host.lock().await.dispatch_target(permit)?;
        let deadline = cdp.deadline(ENGINE_DEADLINE);
        let restore = async {
            if !state.cookies.is_empty() {
                match cdp
                    .request(
                        "Network.setCookies",
                        json!({"cookies":state.cookies}),
                        Some(&session),
                    )
                    .await
                {
                    Ok(_) => {}
                    Err("browser_cdp_request_rejected") => {
                        return Ok(response(Some("browser_state_cookies_rejected"), 0, 0));
                    }
                    Err(_) => {
                        return Err(
                            BrowserEngineError::after("browser_state_outcome_unknown").into()
                        );
                    }
                }
            }
            let mut loaded = 0;
            for origin in &state.origins {
                if origin.local_storage.is_empty() && origin.session_storage.is_empty() {
                    continue;
                }
                // Only the exact committed loader from our own navigation can
                // advance the action. A later unrelated commit cannot do so.
                let navigation = self
                    .resource
                    .host
                    .lock()
                    .await
                    .prepare_action_navigation(permit)?;
                let navigated = self
                    .navigate_page(permit, cdp.clone(), &target, &format!("{}/", origin.origin))
                    .await?;
                if !navigated.success {
                    return Ok(response(
                        Some("browser_state_navigation_failed"),
                        loaded,
                        state.cookies.len(),
                    ));
                }
                let document = BrowserDocumentId::new(
                    navigated.data["loaderId"]
                        .as_str()
                        .ok_or("browser_state_navigation_unconfirmed")?,
                )
                .map_err(|_| "browser_state_navigation_unconfirmed")?;
                self.observe_engine(engine).await?;
                self.resource
                    .host
                    .lock()
                    .await
                    .continue_action_navigation(permit, navigation, &document)?;
                let context = cdp.isolated_context(&session).await?;
                let group = cdp.object_group(&session)?;
                let global = cdp.request("Runtime.evaluate", json!({"expression":"globalThis","contextId":context,"objectGroup":group.name()}), Some(&session)).await?;
                let object = global["result"]["objectId"]
                    .as_str()
                    .ok_or("browser_state_context_missing")?;
                // Bind the object before checking its loader. Numeric context
                // IDs can be reused after a renderer swap; an object handle
                // cannot silently select the replacement world's global.
                if cdp.document(&session).await? != document.as_str() {
                    return Err("browser_state_document_changed".into());
                }
                self.observe_engine(engine).await?;
                self.resource.host.lock().await.dispatch_target(permit)?;
                // Origin validation and all writes share one isolated-world
                // turn. Redirects and page-owned getters cannot redirect data;
                // cross-document navigation destroys this context instead.
                let function = format!(
                    r#"function(){{const state={};if(this.location.origin!==state.origin)return 'origin_mismatch';try{{for(const item of state.localStorage)this.Storage.prototype.setItem.call(this.localStorage,item.name,item.value);for(const item of state.sessionStorage)this.Storage.prototype.setItem.call(this.sessionStorage,item.name,item.value);return 'loaded';}}catch{{return 'storage_rejected';}}}}"#,
                    json!(origin)
                );
                let applied = cdp
                    .request(
                        "Runtime.callFunctionOn",
                        json!({"functionDeclaration":function,"objectId":object,"returnByValue":true}),
                        Some(&session),
                    )
                    .await?;
                let error = match applied["result"]["value"].as_str() {
                    Some("loaded") if applied.get("exceptionDetails").is_none() => None,
                    Some("origin_mismatch") => Some("browser_state_origin_changed"),
                    _ => Some("browser_state_storage_rejected"),
                };
                if let Some(error) = error {
                    return Ok(response(Some(error), loaded, state.cookies.len()));
                }
                loaded += 1;
            }
            Ok(response(None, loaded, state.cookies.len()))
        };
        // Once restore begins, every unaccounted error is an unknown/partial
        // mutation. The existing completion/journal fences further dispatch.
        let result: Result<_, BrowserRuntimeError> = tokio::select! {
            result = restore => result,
            _ = deadline => Err(BrowserEngineError::after("browser_state_outcome_unknown").into()),
        };
        result.map_err(|_| BrowserEngineError::after("browser_state_outcome_unknown").into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_files_validate_all_origins_and_cookie_metadata_before_mutation() {
        let cookie = json!({"name":"auth","value":"한글","domain":"example.test","path":"/","size":12,"session":true,"expires":-1,"httpOnly":true,"secure":false});
        let origin = json!({"origin":"https://example.test/","localStorage":[{"name":"","value":"한글"}],"sessionStorage":[]});
        let bytes =
            serde_json::to_vec(&json!({"cookies":[cookie.clone()],"origins":[origin.clone()]}))
                .unwrap();
        let parsed = StorageState::parse(&bytes).unwrap();
        assert_eq!(parsed.origins[0].origin, "https://example.test");
        assert_eq!(parsed.origins[0].local_storage[0].name, "");
        assert!(parsed.cookies[0].get("size").is_none());
        assert!(parsed.cookies[0].get("session").is_none());
        for url in [
            "file:///private",
            "data:text/html,x",
            "https://other.test/path",
            "https://other.test/?x",
            "https://user:pass@other.test",
            "https://other.test/#x",
        ] {
            let invalid = json!({"cookies":[cookie.clone()],"origins":[origin.clone(),{"origin":url,"localStorage":[]}]});
            assert!(StorageState::parse(&serde_json::to_vec(&invalid).unwrap()).is_err());
        }
        for invalid in [
            json!({"cookies":[cookie.clone()],"origins":[{"origin":"https://example.test","localStorage":[{"name":"bad","value":42}]}]}),
            json!({"cookies":[cookie.clone(),{"name":"broken","value":"x","domain":"example.test","path":"relative"}],"origins":[origin.clone()]}),
            json!({"cookies":[cookie],"origins":[origin],"backend":"other"}),
        ] {
            assert!(StorageState::parse(&serde_json::to_vec(&invalid).unwrap()).is_err());
        }
        for invalid in [b"{broken".as_slice(), &[0xff], b"{}"] {
            assert!(StorageState::parse(invalid).is_err());
        }
    }
}
