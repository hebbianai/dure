//! Fetch uses the retained source connection; Host owns rule decisions.

use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use hmux_session_protocol::browser_interception::BrowserRequestEffect;

/// An adapter dispatch awaiting the Host's existing request metadata, not a
/// second network lifetime ledger. Its native ID is scoped to this connection.
pub(super) struct PausedRequest {
    source: BrowserNetworkId,
    request_id: BrowserNetworkId,
    network_id: Option<BrowserNetworkId>,
    url: String,
    reported_type: String,
    headers: std::collections::BTreeMap<String, String>,
    received: Instant,
}

impl PausedRequest {
    fn bytes(&self) -> usize {
        self.source.as_str().len()
            + self.request_id.as_str().len()
            + self.network_id.as_ref().map_or(0, |id| id.as_str().len())
            + self.url.len()
            + self.reported_type.len()
            + self
                .headers
                .iter()
                .map(|(name, value)| name.len() + value.len())
                .sum::<usize>()
    }
}

impl Monitor {
    pub(super) async fn set_interception(
        &mut self,
        session: &str,
        enabled: bool,
        authentication: bool,
    ) -> Result<(), &'static str> {
        // Filtering is performed once by the Host's parsed URL rules. Fetch
        // stops requests while rules or explicit authentication headers exist.
        // Chromium requires a nonempty pattern for authentication challenges.
        self.cdp
            .request(
                if enabled || authentication {
                    "Fetch.enable"
                } else {
                    "Fetch.disable"
                },
                if enabled || authentication {
                    json!({"patterns":[{"urlPattern":"*","requestStage":"Request"}],"handleAuthRequests":authentication})
                } else {
                    json!({})
                },
                Some(session),
            )
            .await?;
        Ok(())
    }

    pub(super) async fn project_interception(
        &mut self,
        target: &BrowserTargetId,
    ) -> Result<(), &'static str> {
        // Worker loaders inherit their frame's Fetch handler; worker sessions
        // expose Network events but do not implement the Fetch domain. Read
        // Chromium's current target kinds instead of keeping a second registry.
        let census = self
            .cdp
            .request(
                "Target.getTargets",
                json!({"filter":[{"exclude":false}]}),
                None,
            )
            .await?;
        let handlers = census["targetInfos"]
            .as_array()
            .ok_or("browser_interception_targets_invalid")?
            .iter()
            .filter(|info| matches!(info["type"].as_str(), Some("page" | "iframe")))
            .map(|info| {
                BrowserTargetId::new(field(info, "targetId")?)
                    .map_err(|_| "browser_interception_target_invalid")
            })
            .collect::<Result<BTreeSet<_>, _>>()?;
        let (enabled, authentication, sources) = {
            let mut host = self.host.lock().await;
            let enabled = host.interception_enabled(target)
                || host
                    .request_headers(target)
                    .is_some_and(|headers| !headers.is_empty());
            let authentication = host.handles_http_authentication(target);
            let network = host.network();
            let sources = network
                .sources()
                .into_iter()
                .filter(|source| {
                    network.source_target(source) == Some(target)
                        && network
                            .source_engine_target(source)
                            .is_some_and(|target| handlers.contains(target))
                })
                .collect::<Vec<_>>();
            (enabled, authentication, sources)
        };
        if sources.is_empty() {
            return Err("browser_interception_sources_missing");
        }
        for source in sources {
            self.set_interception(source.as_str(), enabled, authentication)
                .await?;
        }
        self.host
            .lock()
            .await
            .interception_applied(target)
            .map_err(|_| "browser_interception_page_closed")
    }

    pub(super) async fn authentication_event(
        &mut self,
        event: &Value,
    ) -> Result<bool, &'static str> {
        if event["method"] != "Fetch.authRequired" {
            return Ok(false);
        }
        let source = BrowserNetworkId::new(field(event, "sessionId")?)?;
        let request = BrowserNetworkId::new(field(&event["params"], "requestId")?)?;
        // The header is already on the request. A rejected preemptive credential
        // must finish as 401/407 instead of opening an unanswerable native prompt.
        let response = {
            let mut host = self.host.lock().await;
            let target = host
                .network()
                .source_target(&source)
                .cloned()
                .ok_or("browser_authentication_source_missing")?;
            let name = match event["params"]["authChallenge"]["source"].as_str() {
                Some("Server") => "authorization",
                Some("Proxy") => "proxy-authorization",
                _ => return Err("browser_authentication_challenge_invalid"),
            };
            if host
                .request_headers(&target)
                .is_some_and(|headers| headers.contains_key(name))
            {
                "CancelAuth"
            } else {
                "Default"
            }
        };
        match self
            .cdp
            .request(
                "Fetch.continueWithAuth",
                json!({"requestId":request.as_str(),"authChallengeResponse":{"response":response}}),
                Some(source.as_str()),
            )
            .await
        {
            Ok(_) | Err("browser_cdp_interception_gone") => Ok(true),
            Err(code) => Err(code),
        }
    }

    pub(super) fn interception_event(&mut self, event: &Value) -> Result<bool, &'static str> {
        if event["method"] != "Fetch.requestPaused" {
            return Ok(false);
        }
        let params = &event["params"];
        let request = PausedRequest {
            source: BrowserNetworkId::new(field(event, "sessionId")?)?,
            request_id: BrowserNetworkId::new(field(params, "requestId")?)?,
            network_id: params["networkId"]
                .as_str()
                .map(BrowserNetworkId::new)
                .transpose()?,
            url: field(&params["request"], "url")?.to_owned(),
            reported_type: field(params, "resourceType")?.to_owned(),
            headers: serde_json::from_value(params["request"]["headers"].clone())
                .map_err(|_| "browser_interception_headers_invalid")?,
            received: Instant::now(),
        };
        if request.url.len() > 16 * 1024
            || request.reported_type.len() > 64
            || request
                .headers
                .iter()
                .map(|(name, value)| name.len() + value.len())
                .sum::<usize>()
                > 64 * 1024
            || self.interceptions.len() >= 256
            || self
                .interceptions
                .iter()
                .map(PausedRequest::bytes)
                .sum::<usize>()
                + request.bytes()
                > 1024 * 1024
        {
            return Err("browser_interception_queue_limit");
        }
        self.interceptions.push_back(request);
        Ok(true)
    }

    pub(super) fn interception_wait_remaining(&self) -> Result<Option<Duration>, &'static str> {
        self.interceptions
            .iter()
            .map(|request| {
                Duration::from_secs(5)
                    .checked_sub(request.received.elapsed())
                    .filter(|remaining| !remaining.is_zero())
                    .ok_or("browser_interception_metadata_timeout")
            })
            .collect::<Result<Vec<_>, _>>()
            .map(|budgets| budgets.into_iter().min())
    }

    pub(super) async fn resolve_interceptions(&mut self) -> Result<(), &'static str> {
        for _ in 0..self.interceptions.len() {
            let request = self
                .interceptions
                .pop_front()
                .expect("bounded pending operation");
            let (effect, headers) = {
                let mut host = self.host.lock().await;
                // This connection only receives pauses from handlers it installed.
                // A withdrawn source has already retired its native operations.
                if !host.network().source_is_attached(&request.source) {
                    continue;
                }
                let target = host
                    .network()
                    .source_target(&request.source)
                    .cloned()
                    .ok_or("browser_interception_source_missing")?;
                let kind = match &request.network_id {
                    Some(id) => host
                        .network()
                        .request_resource_type(&request.source, id)
                        .map(str::to_owned),
                    None => Some(request.reported_type.clone()),
                };
                (
                    host.intercepted_request(&target, &request.url, kind.as_deref()),
                    host.request_headers(&target).cloned().unwrap_or_default(),
                )
            };
            let Some(effect) = effect else {
                // Cross-process Fetch and Network events can arrive in either
                // order. Retain the dispatch, never guess the renderer's type.
                self.interceptions.push_back(request);
                continue;
            };
            let (method, value) = match effect {
                BrowserRequestEffect::Continue => {
                    let mut params = json!({"requestId":request.request_id.as_str()});
                    if !headers.is_empty() {
                        // Fetch replaces the full native header list. Preserve
                        // page-generated fields and override configured names.
                        let mut retained = request.headers;
                        retained
                            .retain(|name, _| !headers.contains_key(&name.to_ascii_lowercase()));
                        retained.extend(headers);
                        params["headers"] = json!(
                            retained
                                .into_iter()
                                .map(|(name, value)| json!({"name":name,"value":value}))
                                .collect::<Vec<_>>()
                        );
                    }
                    ("Fetch.continueRequest", params)
                }
                BrowserRequestEffect::Abort => (
                    "Fetch.failRequest",
                    json!({"requestId":request.request_id.as_str(),"errorReason":"Failed"}),
                ),
                BrowserRequestEffect::Respond {
                    body,
                    status,
                    headers,
                } => (
                    "Fetch.fulfillRequest",
                    json!({"requestId":request.request_id.as_str(),"responseCode":status,"body":STANDARD.encode(body.as_bytes()),
                        "responseHeaders":headers.into_iter().map(|(name,value)| json!({"name":name,"value":value})).collect::<Vec<_>>()}),
                ),
            };
            match self
                .cdp
                .request(method, value, Some(request.source.as_str()))
                .await
            {
                Ok(_) | Err("browser_cdp_interception_gone") => {}
                Err(code) => return Err(code),
            }
        }
        Ok(())
    }
}

impl BrowserEventMonitor {
    pub(in crate::browser_engine::runtime) async fn apply_interception(
        &self,
        target: BrowserTargetId,
    ) -> Result<(), &'static str> {
        let result = timeout(Duration::from_secs(5), async {
            let (sender, receiver) = oneshot::channel();
            self.barriers
                .send(Barrier::Interception(self.resource.clone(), target, sender))
                .await
                .map_err(|_| "browser_network_observation_lost")?;
            receiver
                .await
                .map_err(|_| "browser_network_observation_lost")?
        })
        .await
        .map_err(|_| "browser_interception_projection_timeout")
        .and_then(|result| result);
        if result.is_err() {
            // Settle this exact retained connection before returning an unknown
            // outcome. A timed-out queued projection cannot resume later.
            self.close().await;
        }
        result
    }
}

#[cfg(test)]
mod tests;
