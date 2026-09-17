//! Chromium owns cookies and web storage. Host owns mutation admission; this
//! adapter addresses the admitted target without invoking page-owned getters.

use super::{BrowserActionPermit, BrowserCdp, BrowserRuntimeError, Execution};
use crate::browser_engine::{BrowserEngineError, NativeBrowserEngine, NativeBrowserResponse};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Debug, Deserialize, Serialize)]
#[serde(try_from = "String")]
pub(super) struct CookieUrl(String);

impl TryFrom<String> for CookieUrl {
    type Error = &'static str;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        let url = Url::parse(&value).map_err(|_| "browser_cookie_url_invalid")?;
        if value.len() > 8192
            || !matches!(url.scheme(), "http" | "https")
            || url.host_str().is_none_or(str::is_empty)
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err("browser_cookie_url_invalid");
        }
        Ok(Self(url.into()))
    }
}

#[derive(Debug, Deserialize, Serialize)]
pub(super) enum SameSite {
    Strict,
    Lax,
    None,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Cookie {
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    value: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<CookieUrl>,
    #[serde(skip_serializing_if = "Option::is_none")]
    domain: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    secure: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    http_only: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    same_site: Option<SameSite>,
    #[serde(skip_serializing_if = "Option::is_none")]
    expires: Option<f64>,
}

impl Cookie {
    pub(super) fn validate(&self, setting: bool) -> Result<(), &'static str> {
        if self.name.is_empty()
            || self.name.len() > 4096
            || self
                .name
                .bytes()
                .any(|byte| byte <= 32 || byte == 127 || b";=,".contains(&byte))
            || self.value.as_ref().is_some_and(|value| {
                value.len() > 4096
                    || value
                        .bytes()
                        .any(|byte| byte < 32 || byte == 127 || byte == b';')
            })
            || self.domain.as_ref().is_some_and(|domain| {
                domain.is_empty() || domain.len() > 253 || domain.chars().any(char::is_whitespace)
            })
            || self.path.as_ref().is_some_and(|path| {
                !path.starts_with('/') || path.len() > 4096 || path.chars().any(char::is_control)
            })
            || self
                .expires
                .is_some_and(|expires| !expires.is_finite() || expires < -1.0)
            || (setting && self.value.is_none())
            || (!setting
                && (self.value.is_some()
                    || self.secure.is_some()
                    || self.http_only.is_some()
                    || self.same_site.is_some()
                    || self.expires.is_some()))
        {
            return Err("browser_cookie_invalid");
        }
        Ok(())
    }

    fn parameters(&self, current_url: &str) -> Result<Value, &'static str> {
        let mut value = serde_json::to_value(self).map_err(|_| "browser_cookie_invalid")?;
        if self.url.is_none() && self.domain.is_none() {
            value["url"] = CookieUrl::try_from(current_url.to_owned())?.0.into();
        }
        Ok(value)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum StorageArea {
    Local,
    Session,
}

#[derive(Debug, Deserialize)]
#[serde(try_from = "DataQuery")]
pub(super) struct BrowserDataQuery(DataQuery);

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum DataQuery {
    Cookies {
        url: Option<CookieUrl>,
    },
    Storage {
        area: StorageArea,
        key: Option<String>,
    },
}

impl TryFrom<DataQuery> for BrowserDataQuery {
    type Error = &'static str;
    fn try_from(value: DataQuery) -> Result<Self, Self::Error> {
        if let DataQuery::Storage { key: Some(key), .. } = &value {
            if key.len() > 64 * 1024 {
                return Err("browser_storage_key_invalid");
            }
        }
        Ok(Self(value))
    }
}

#[derive(Debug, Deserialize)]
#[serde(try_from = "DataAction")]
pub(super) struct BrowserDataAction(DataAction);

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum DataAction {
    CookieSet {
        cookie: Cookie,
    },
    CookiesSet {
        cookies: Vec<Cookie>,
    },
    CookiesClear {},
    CookieDelete {
        cookie: Cookie,
    },
    StorageSet {
        area: StorageArea,
        key: String,
        value: String,
    },
    StorageClear {
        area: StorageArea,
    },
}

impl TryFrom<DataAction> for BrowserDataAction {
    type Error = &'static str;
    fn try_from(value: DataAction) -> Result<Self, Self::Error> {
        match &value {
            DataAction::CookieSet { cookie } => cookie.validate(true)?,
            DataAction::CookiesSet { cookies } => {
                if cookies.len() > 256
                    || serde_json::to_vec(cookies)
                        .map_err(|_| "browser_cookie_import_invalid")?
                        .len()
                        > 64 * 1024
                {
                    return Err("browser_cookie_import_invalid");
                }
                for cookie in cookies {
                    cookie.validate(true)?;
                }
            }
            DataAction::CookieDelete { cookie } => cookie.validate(false)?,
            DataAction::StorageSet { key, value, .. }
                if key.len() > 64 * 1024 || value.len() > 64 * 1024 =>
            {
                return Err("browser_storage_value_invalid");
            }
            _ => {}
        }
        Ok(Self(value))
    }
}

struct DataPage {
    cdp: BrowserCdp,
    session: String,
    frame: Value,
}

impl DataPage {
    async fn attach(mut cdp: BrowserCdp, target: &str) -> Result<Self, &'static str> {
        let session = cdp.attach(target).await?;
        let frame = cdp.frame_metadata(&session).await?;
        Ok(Self {
            cdp,
            session,
            frame,
        })
    }

    async fn storage(&mut self, area: &StorageArea) -> Result<Value, &'static str> {
        let frame = self.frame["id"]
            .as_str()
            .ok_or("browser_storage_frame_missing")?;
        let key = self
            .cdp
            .request(
                "Storage.getStorageKey",
                json!({"frameId":frame}),
                Some(&self.session),
            )
            .await?;
        let key = key["storageKey"]
            .as_str()
            .filter(|key| !key.is_empty())
            .ok_or("browser_storage_key_missing")?;
        Ok(json!({"storageKey":key,"isLocalStorage":matches!(area, StorageArea::Local)}))
    }
}

impl BrowserDataQuery {
    pub(super) async fn read(&self, cdp: BrowserCdp, target: &str) -> Result<Value, &'static str> {
        let mut page = DataPage::attach(cdp, target).await?;
        match &self.0 {
            DataQuery::Cookies { url } => {
                let params = match url {
                    Some(url) => json!({"urls":[url.0]}),
                    None => json!({}),
                };
                page.cdp
                    .request("Network.getCookies", params, Some(&page.session))
                    .await
            }
            DataQuery::Storage { area, key } => {
                let storage = page.storage(area).await?;
                let result = page
                    .cdp
                    .request(
                        "DOMStorage.getDOMStorageItems",
                        json!({"storageId":storage}),
                        Some(&page.session),
                    )
                    .await?;
                let entries = result["entries"]
                    .as_array()
                    .ok_or("browser_storage_response_invalid")?;
                let mut value = Value::Null;
                let mut data = serde_json::Map::new();
                for entry in entries {
                    let entry = entry
                        .as_array()
                        .filter(|entry| entry.len() == 2 && entry.iter().all(Value::is_string))
                        .ok_or("browser_storage_response_invalid")?;
                    if let Some(key) = key {
                        if entry[0] == *key {
                            value = entry[1].clone();
                        }
                    } else {
                        data.insert(entry[0].as_str().unwrap().to_owned(), entry[1].clone());
                    }
                }
                Ok(match key {
                    Some(key) => json!({"key":key,"value":value}),
                    None => json!({"data":data}),
                })
            }
        }
    }
}

impl Execution<'_> {
    pub(super) async fn data_action(
        &self,
        engine: &mut NativeBrowserEngine,
        permit: &BrowserActionPermit,
        cdp: BrowserCdp,
        action: &BrowserDataAction,
    ) -> Result<NativeBrowserResponse, BrowserRuntimeError> {
        let target = self
            .resource
            .host
            .lock()
            .await
            .dispatch_target(permit)?
            .clone();
        let mut page = DataPage::attach(cdp, target.as_str()).await?;
        let (method, params, result) = match &action.0 {
            DataAction::CookiesSet { cookies } => {
                let url = page.frame["url"]
                    .as_str()
                    .ok_or("browser_cookie_url_missing")?;
                let cookies = cookies
                    .iter()
                    .map(|cookie| cookie.parameters(url))
                    .collect::<Result<Vec<_>, _>>()?;
                (
                    "Network.setCookies",
                    json!({"cookies":cookies}),
                    json!({"set":true}),
                )
            }
            DataAction::CookiesClear {} => (
                "Network.clearBrowserCookies",
                json!({}),
                json!({"cleared":true}),
            ),
            DataAction::CookieSet { cookie } => (
                "Network.setCookie",
                cookie.parameters(
                    page.frame["url"]
                        .as_str()
                        .ok_or("browser_cookie_url_missing")?,
                )?,
                json!({"set":true}),
            ),
            DataAction::CookieDelete { cookie } => (
                "Network.deleteCookies",
                cookie.parameters(
                    page.frame["url"]
                        .as_str()
                        .ok_or("browser_cookie_url_missing")?,
                )?,
                json!({"deleted":true,"name":cookie.name}),
            ),
            DataAction::StorageSet { area, key, value } => (
                "DOMStorage.setDOMStorageItem",
                json!({"storageId":page.storage(area).await?,"key":key,"value":value}),
                json!({"set":true}),
            ),
            DataAction::StorageClear { area } => (
                "DOMStorage.clear",
                json!({"storageId":page.storage(area).await?}),
                json!({"cleared":true}),
            ),
        };
        // Host checks the current document after resolving its storage identity.
        self.observe_engine(engine).await?;
        self.resource.host.lock().await.dispatch_frame(permit)?;
        let reply = page.cdp.request(method, params, Some(&page.session)).await;
        let error = match reply {
            Ok(reply) if reply.get("success").is_some_and(|success| success != true) => {
                Some("browser_cookie_rejected")
            }
            Ok(_) => None,
            Err("browser_cdp_request_rejected") => Some("browser_data_rejected"),
            Err(_) => return Err(BrowserEngineError::after("browser_data_outcome_unknown").into()),
        };
        Ok(NativeBrowserResponse {
            id: "browser-data".into(),
            success: error.is_none(),
            error: error.map(String::from),
            data: if error.is_none() { result } else { json!({}) },
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cookie_batches_validate_every_entry_before_admission_and_bound_clear_scope() {
        for value in [
            json!({"kind":"cookies_set","cookies":[{"name":"one","value":""},{"name":"two","value":"two","domain":"example.test","path":"/"}]}),
            json!({"kind":"cookies_set","cookies":[]}),
            json!({"kind":"cookies_clear"}),
        ] {
            assert!(serde_json::from_value::<BrowserDataAction>(value).is_ok());
        }
        for value in [
            json!({"kind":"cookies_set","cookies":[{"name":"one","value":"ok"},{"name":"bad;name","value":"bad"}]}),
            json!({"kind":"cookies_set","cookies":[{"name":"one","value":"ok"},{"name":"missing-value"}]}),
            json!({"kind":"cookies_set","cookies":[{"name":"one","value":"ok","unknown":true}]}),
            json!({"kind":"cookies_set","cookies":vec![json!({"name":"one","value":"ok"});257]}),
            json!({"kind":"cookies_set","cookies":vec![json!({"name":"one","value":"x".repeat(4096)});16]}),
            json!({"kind":"cookies_clear","url":"https://example.test"}),
            json!({"kind":"cookies_clear","profile":"other"}),
        ] {
            assert!(serde_json::from_value::<BrowserDataAction>(value).is_err());
        }
    }

    #[test]
    fn storage_query_distinguishes_an_omitted_key_from_an_empty_key_and_keeps_byte_bounds() {
        let all: BrowserDataQuery =
            serde_json::from_value(json!({"kind":"storage","area":"local"})).unwrap();
        assert!(matches!(all.0, DataQuery::Storage { key: None, .. }));
        let empty: BrowserDataQuery =
            serde_json::from_value(json!({"kind":"storage","area":"session","key":""})).unwrap();
        assert!(matches!(empty.0, DataQuery::Storage { key: Some(key), .. } if key.is_empty()));
        for query in [
            json!({"kind":"storage","area":"local","key":42}),
            json!({"kind":"storage","area":"local","key":"한".repeat(21846)}),
            json!({"kind":"storage","area":"local","unknown":true}),
        ] {
            assert!(serde_json::from_value::<BrowserDataQuery>(query).is_err());
        }
        assert!(
            serde_json::from_value::<BrowserDataQuery>(
                json!({"kind":"storage","area":"local","key":"a".repeat(64 * 1024)})
            )
            .is_ok()
        );
    }
}
