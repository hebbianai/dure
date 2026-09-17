use super::*;
use crate::browser_engine::runtime::events::navigation::NavigationEventKind;
use hmux_host::browser_network::BrowserNetworkId;

pub(in super::super) enum HistoryAction {
    Back,
    Forward,
    Reload,
}

impl Execution<'_> {
    pub(in super::super) async fn push_state_action(
        &self,
        permit: &BrowserActionPermit,
        cdp: BrowserCdp,
        url: &str,
    ) -> Result<NativeBrowserResponse, BrowserRuntimeError> {
        let script = include_str!("push-state.js").replace(
            "\"{{URL}}\"",
            &serde_json::to_string(url).map_err(|_| "browser_history_url_invalid")?,
        );
        let mut response = self
            .evaluate_action(permit, cdp, &script, ENGINE_DEADLINE)
            .await?;
        if response.success {
            response.id = "browser-pushstate".into();
            response.data = json!({"url":response.data["result"]});
        }
        Ok(response)
    }

    pub(in super::super) async fn history_action(
        &self,
        permit: &BrowserActionPermit,
        action: HistoryAction,
    ) -> Result<NativeBrowserResponse, BrowserRuntimeError> {
        Ok(self.history_navigation(permit, action).await?.0)
    }

    pub(in super::super) async fn history_navigation(
        &self,
        permit: &BrowserActionPermit,
        action: HistoryAction,
    ) -> Result<
        (
            NativeBrowserResponse,
            Option<super::super::BrowserDocumentId>,
        ),
        BrowserRuntimeError,
    > {
        let (target, source) = {
            let mut host = self.resource.host.lock().await;
            let target = host.dispatch_target(permit)?.clone();
            let source = host
                .network()
                .page_source(&target)
                .ok_or("browser_page_source_missing")?;
            (target, source)
        };
        // Commands and completions use the existing retained Page session.
        // A second observer cannot establish this stream's ordering or identity.
        let mut cdp = self.renderer_cdp(self.binding.events.cdp.clone(), target.clone());
        let session = Some(source.as_str());
        let tree = cdp.request("Page.getFrameTree", json!({}), session).await?;
        let frame = &tree["frameTree"]["frame"];
        let main_frame =
            BrowserNetworkId::new(frame["id"].as_str().ok_or("browser_frame_missing")?)?;
        let command = match action {
            HistoryAction::Reload => Some(("Page.reload", json!({"loaderId":frame["loaderId"]}))),
            HistoryAction::Back | HistoryAction::Forward => {
                let history = cdp
                    .request("Page.getNavigationHistory", json!({}), session)
                    .await?;
                let index = history["currentIndex"]
                    .as_i64()
                    .ok_or("browser_history_invalid")?;
                let next = index
                    + if matches!(action, HistoryAction::Back) {
                        -1
                    } else {
                        1
                    };
                let entries = history["entries"]
                    .as_array()
                    .ok_or("browser_history_invalid")?;
                usize::try_from(next)
                    .ok()
                    .and_then(|index| entries.get(index))
                    .map(|entry| {
                        (
                            "Page.navigateToHistoryEntry",
                            json!({"entryId":entry["id"]}),
                        )
                    })
            }
        };
        self.binding.events.synchronize_events().await?;
        let mut events = self.binding.events.navigation.subscribe();
        self.resource.host.lock().await.dispatch_target(permit)?;
        let deadline = cdp.deadline(ENGINE_DEADLINE);
        let navigation = async {
            let mut committed = None;
            if let Some((method, params)) = command {
                cdp.request_with_deadline(method, params, session, ENGINE_DEADLINE)
                    .await?;
                // History/reload acknowledge dispatch before commit. Wait for a
                // fresh main-frame navigation and its completion, including the
                // known no-commit result of dismissing beforeunload.
                let mut started = false;
                loop {
                    let event = events
                        .recv()
                        .await
                        .map_err(|_| "browser_navigation_observation_lost")?;
                    if event.source != source {
                        continue;
                    }
                    match event.kind {
                        NavigationEventKind::Started(frame) if frame == main_frame => {
                            started = true
                        }
                        NavigationEventKind::Committed(frame, document)
                            if frame == main_frame && started =>
                        {
                            if committed.is_none() {
                                committed = Some(document);
                            }
                        }
                        NavigationEventKind::Stopped(frame) if frame == main_frame && started => {
                            break;
                        }
                        NavigationEventKind::SameDocument(frame) if frame == main_frame => break,
                        NavigationEventKind::Cancelled => break,
                        _ => {}
                    }
                }
            }
            let info = cdp
                .request("Target.getTargetInfo", json!({"targetId":target}), None)
                .await?;
            Ok((
                NativeBrowserResponse {
                    id: "browser-history".into(),
                    success: true,
                    data: json!({"url":info["targetInfo"]["url"]}),
                    error: None,
                },
                committed,
            ))
        };
        let result: Result<_, &'static str> = tokio::select! {
            result = navigation => result,
            code = deadline => Err(code),
        };
        result.map_err(|_| BrowserEngineError::after("browser_navigation_outcome_unknown").into())
    }
}
