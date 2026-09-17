use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use hmux_session_protocol::{
    browser_interception::BrowserInterceptionAction, browser_resource::BrowserPageIdentity,
};

impl Execution<'_> {
    pub(in crate::browser_engine::runtime) async fn save_state(
        &self,
        engine: &mut NativeBrowserEngine,
        permit: &BrowserActionPermit,
        page: &BrowserPageIdentity,
        mut cdp: BrowserCdp,
        encryption_key: Option<&BrowserStateKey>,
    ) -> Result<NativeBrowserResponse, BrowserRuntimeError> {
        let (target, mut visited) = {
            let host = self.resource.host.lock().await;
            (
                host.dispatch_target(permit)?.clone(),
                host.storage_origins(page)?.clone(),
            )
        };
        let session = cdp.attach(target.as_str()).await?;
        let native = cdp
            .request("Network.getAllCookies", json!({}), Some(&session))
            .await?;
        let mut cookies = native["cookies"]
            .as_array()
            .ok_or("browser_state_cookies_invalid")?
            .clone();
        // The portable format preserves Network.Cookie's writable common
        // fields, matching the pinned engine's serialized Cookie projection.
        for cookie in &mut cookies {
            cookie
                .as_object_mut()
                .ok_or("browser_state_cookies_invalid")?
                .retain(|key, _| {
                    matches!(
                        key.as_str(),
                        "name"
                            | "value"
                            | "domain"
                            | "path"
                            | "expires"
                            | "httpOnly"
                            | "secure"
                            | "sameSite"
                            | "size"
                            | "session"
                    )
                });
        }
        let mut state = StorageState {
            cookies,
            origins: Vec::new(),
        };
        let mut bytes = serde_json::to_vec(&state)
            .map_err(|_| "browser_state_encoding_failed")?
            .len();
        if let Some(origin) = read_origin(&mut cdp, &session, true).await? {
            visited.remove(&origin.origin);
            push_origin(&mut state, origin, &mut bytes)?;
        }
        self.observe_engine(engine).await?;
        self.resource.host.lock().await.dispatch_target(permit)?;
        if !visited.is_empty() {
            let context = self.binding.events.storage_context(target.clone()).await?;
            let creation = self
                .resource
                .host
                .lock()
                .await
                .prepare_page_creation(permit)?;
            let temporary = self
                .binding
                .events
                .create_page_in(
                    creation,
                    super::super::events::PageCreationContext::Existing(context),
                )
                .await
                .map_err(|_| BrowserEngineError::after("browser_state_page_creation_unknown"))?;
            let read: Result<(), BrowserRuntimeError> = async {
                self.binding.events.synchronize(&temporary).await?;
                let rule: BrowserInterceptionAction = serde_json::from_value(json!({
                    "kind":"enable","rule":{"patterns":["*"],"effect":{"kind":"respond","status":200,"body":"<!doctype html><html></html>","headers":{"Content-Type":"text/html"}}}
                })).map_err(|_| "browser_state_interception_invalid")?;
                self.resource.host.lock().await.configure_created_page_interception(permit, &rule)?;
                self.binding.events.apply_interception(temporary.clone()).await?;
                let mut reader = self.renderer_cdp(cdp.clone(), temporary.clone());
                let session = reader.attach(temporary.as_str()).await?;
                reader.request("Network.setBypassServiceWorker", json!({"bypass":true}), Some(&session)).await?;
                reader.request("Network.setCacheDisabled", json!({"cacheDisabled":true}), Some(&session)).await?;
                let deadline = reader.deadline(ENGINE_DEADLINE);
                let collect = async {
                    for origin in visited {
                        let navigation = self.navigate_page(permit, reader.clone(), &temporary, &format!("{origin}/")).await?;
                        if !navigation.success {
                            return Err("browser_state_navigation_failed".into());
                        }
                        let storage = read_origin(&mut reader, &session, false).await?.ok_or("browser_state_origin_missing")?;
                        if storage.origin != origin {
                            return Err("browser_state_origin_changed".into());
                        }
                        push_origin(&mut state, storage, &mut bytes)?;
                    }
                    Ok::<_, BrowserRuntimeError>(())
                };
                tokio::select! {
                    result = collect => result,
                    code = deadline => Err(code.into()),
                }
            }.await;
            // Cleanup uses the retained browser connection, independent of a
            // source document that may have disappeared during the export.
            let cleanup = super::super::lifecycle::close_targets(
                &mut self.binding.events.cdp.clone(),
                &[temporary],
            )
            .await;
            if cleanup.is_err() {
                return Err(
                    BrowserEngineError::after("browser_state_page_retirement_unknown").into(),
                );
            }
            self.binding
                .events
                .synchronize_events()
                .await
                .map_err(|_| {
                    BrowserEngineError::after("browser_state_page_retirement_unobserved")
                })?;
            read?;
        }
        self.observe_engine(engine).await?;
        self.resource.host.lock().await.dispatch_target(permit)?;
        let bytes = serde_json::to_vec(&state).map_err(|_| "browser_state_encoding_failed")?;
        if bytes.len() > super::super::capture::MAX_ARTIFACT_BYTES {
            return Err("browser_artifact_too_large".into());
        }
        // Exported native data must also satisfy our whole-file import contract.
        StorageState::parse(&bytes)?;
        let (bytes, mime, filename) = match encryption_key {
            Some(key) => (
                key.encrypt(&bytes)?,
                "application/octet-stream",
                "browser-state.json.enc",
            ),
            None => (bytes, "application/json", "browser-state.json"),
        };
        Ok(NativeBrowserResponse {
            id: "browser-state-save".into(),
            success: true,
            error: None,
            data: json!({"saved":true,"encrypted":encryption_key.is_some(),"origins_saved":state.origins.len(),"cookies_saved":state.cookies.len(),"artifact_payload":{"page":page,"mime_type":mime,"suggested_filename":filename,"base64":STANDARD.encode(bytes)}}),
        })
    }
}

fn push_origin(
    state: &mut StorageState,
    origin: OriginStorage,
    bytes: &mut usize,
) -> Result<(), &'static str> {
    if origin.local_storage.is_empty() && origin.session_storage.is_empty() {
        return Ok(());
    }
    *bytes += serde_json::to_vec(&origin)
        .map_err(|_| "browser_state_encoding_failed")?
        .len()
        + 1;
    if *bytes > super::super::capture::MAX_ARTIFACT_BYTES {
        return Err("browser_artifact_too_large");
    }
    state.origins.push(origin);
    Ok(())
}

async fn read_origin(
    cdp: &mut BrowserCdp,
    session: &str,
    include_session: bool,
) -> Result<Option<OriginStorage>, &'static str> {
    let tree = cdp
        .request("Page.getFrameTree", json!({}), Some(session))
        .await?;
    let frame = &tree["frameTree"]["frame"];
    let url = Url::parse(frame["url"].as_str().ok_or("browser_state_url_missing")?)
        .map_err(|_| "browser_state_url_invalid")?;
    if !matches!(url.scheme(), "http" | "https") {
        return Ok(None);
    }
    let document = frame["loaderId"]
        .as_str()
        .ok_or("browser_state_document_missing")?;
    let key = cdp
        .request(
            "Storage.getStorageKey",
            json!({"frameId":frame["id"]}),
            Some(session),
        )
        .await?;
    let key = key["storageKey"]
        .as_str()
        .ok_or("browser_storage_key_missing")?;
    let mut storage = OriginStorage {
        origin: url.origin().ascii_serialization(),
        local_storage: Vec::new(),
        session_storage: Vec::new(),
    };
    for local in [true, false] {
        if !local && !include_session {
            continue;
        }
        let native = cdp
            .request(
                "DOMStorage.getDOMStorageItems",
                json!({"storageId":{"storageKey":key,"isLocalStorage":local}}),
                Some(session),
            )
            .await?;
        let entries: Vec<[String; 2]> = serde_json::from_value(native["entries"].clone())
            .map_err(|_| "browser_storage_response_invalid")?;
        let entries = entries
            .into_iter()
            .map(|[name, value]| StorageEntry { name, value })
            .collect();
        if local {
            storage.local_storage = entries;
        } else {
            storage.session_storage = entries;
        }
    }
    if cdp.document(session).await? != document {
        return Err("browser_state_document_changed");
    }
    Ok(Some(storage))
}
