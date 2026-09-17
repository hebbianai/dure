//! Saved profile settings use the existing application store and operation
//! journal. Creating a record neither launches nor imports a browser session.
use dure_app::{
    BrowserProfileIdV1, BrowserProfileScopeV1, BrowserProfileSpecV1, BrowserProfileStateV1,
    BrowserProfileStore, BrowserProfileUserAgentModeV1, DomainStoreErrorV1, OperationIdV1,
};
use dure_app_sqlite::SqliteDomainStore;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::{BackendDispatchError, BrowserService, ManagedBrowser, require_development};
use crate::browser_engine::runtime::{BrowserProfileAction, BrowserProfileSource};
use hmux_session_protocol::browser_resource::{
    BrowserActionAuthority, BrowserControllerId, BrowserResourceId,
};
use std::collections::BTreeMap;

mod deletion;

pub(super) async fn source(
    resources: &BTreeMap<BrowserResourceId, ManagedBrowser>,
    profile: &BrowserProfileIdV1,
) -> Option<BrowserProfileSource> {
    for managed in resources.values() {
        if let Some(source) = managed.runtime.profile_source(profile).await {
            return Some(source);
        }
    }
    None
}

impl BrowserService {
    pub(super) async fn profile_action(
        &self,
        store: &SqliteDomainStore,
        caller: &BrowserControllerId,
        authority: &BrowserActionAuthority,
        action: BrowserProfileAction,
        profile_id: BrowserProfileIdV1,
    ) -> Result<Value, BackendDispatchError> {
        let runtime = self.bound_resource(&authority.lease.resource).await?;
        let config = self.config()?;
        let resources = self.resources.lock().await;
        let profile = selected(store, Some(profile_id)).await?;
        let source = source(&resources, profile.profile_id()).await;
        let change = runtime
            .admit_profile_change(caller, authority, &config, action, &profile, source)
            .await
            .map_err(super::runtime_error)?;
        drop(resources);
        Ok(json!(change.finish().await.map_err(super::runtime_error)?))
    }
}

pub(super) async fn list(store: &SqliteDomainStore) -> Result<Value, BackendDispatchError> {
    require_development()?;
    Ok(json!({"profiles":store.browser_profiles().await.map_err(store_error)?}))
}

pub(super) async fn selected(
    store: &SqliteDomainStore,
    requested: Option<BrowserProfileIdV1>,
) -> Result<BrowserProfileSpecV1, BackendDispatchError> {
    let id = requested.unwrap_or_else(|| BrowserProfileIdV1::new("default").unwrap());
    let record = store
        .browser_profile(&id)
        .await
        .map_err(store_error)?
        .ok_or_else(|| BackendDispatchError::terminal("browser_profile_missing"))?;
    match record.state {
        BrowserProfileStateV1::Active => Ok(record.profile),
        BrowserProfileStateV1::Retiring => {
            Err(BackendDispatchError::terminal("browser_profile_retiring"))
        }
        BrowserProfileStateV1::Deleted => {
            Err(BackendDispatchError::terminal("browser_profile_deleted"))
        }
    }
}

pub(super) async fn create(
    store: &SqliteDomainStore,
    operation: &OperationIdV1,
    label: String,
    scope: BrowserProfileScopeV1,
    user_agent_mode: BrowserProfileUserAgentModeV1,
) -> Result<Value, BackendDispatchError> {
    require_development()?;
    let id = BrowserProfileIdV1::new(format!(
        "browser-profile:{:x}",
        Sha256::digest(operation.as_str().as_bytes())
    ))
    .expect("bounded profile identity derived from an admitted operation");
    let profile = BrowserProfileSpecV1::new(id, label, scope, user_agent_mode)
        .map_err(|_| BackendDispatchError::terminal("browser_profile_invalid"))?;
    Ok(json!({"profile":store.create_browser_profile(&profile).await.map_err(store_error)?}))
}

fn store_error(error: DomainStoreErrorV1) -> BackendDispatchError {
    BackendDispatchError::terminal(match error {
        DomainStoreErrorV1::IdentityConflict { .. } => "browser_profile_conflict",
        _ => "browser_profile_store_unavailable",
    })
}
