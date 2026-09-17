//! Transient navigation completions from the retained, Host-bound Page stream.

use super::*;
use hmux_session_protocol::browser_dialog::BrowserDialogKind;
use hmux_session_protocol::browser_resource::BrowserDocumentId;

#[derive(Clone)]
pub(in super::super) struct NavigationEvent {
    pub(in super::super) source: BrowserNetworkId,
    pub(in super::super) kind: NavigationEventKind,
}

#[derive(Clone)]
pub(in super::super) enum NavigationEventKind {
    Started(BrowserNetworkId),
    Stopped(BrowserNetworkId),
    Committed(BrowserNetworkId, BrowserDocumentId),
    SameDocument(BrowserNetworkId),
    Cancelled,
}

impl Monitor {
    pub(super) async fn navigation_event(
        &self,
        event: &Value,
    ) -> Result<Option<NavigationEvent>, &'static str> {
        let method = event["method"].as_str().unwrap_or("");
        if !matches!(
            method,
            "Page.frameStartedNavigating"
                | "Page.frameStoppedLoading"
                | "Page.frameNavigated"
                | "Page.navigatedWithinDocument"
                | "Page.javascriptDialogClosed"
        ) {
            return Ok(None);
        }
        let source = BrowserNetworkId::new(field(event, "sessionId")?)?;
        let mut host = self.host.lock().await;
        let Some(target) = host.network().source_target(&source).cloned() else {
            return Ok(None);
        };
        if host.network().page_source(&target).as_ref() != Some(&source) {
            return Ok(None);
        }
        let params = &event["params"];
        let kind = if method == "Page.frameNavigated" {
            let frame = &params["frame"];
            let Some(loader) = frame["loaderId"].as_str().filter(|id| !id.is_empty()) else {
                return Ok(None);
            };
            NavigationEventKind::Committed(
                BrowserNetworkId::new(field(frame, "id")?)?,
                BrowserDocumentId::new(loader)
                    .map_err(|_| "browser_navigation_document_invalid")?,
            )
        } else if method == "Page.javascriptDialogClosed" {
            let page = host
                .page_for_target(&target)
                .ok_or("browser_page_missing")?;
            // Read the one pending-dialog authority before its ordered close
            // event retires it. A dismissed prompt/confirm is not navigation.
            let dialog = host
                .dialog_observation(&page.page_id)
                .map_err(|_| "browser_dialog_event_invalid")?;
            if params["result"] != false
                || !dialog
                    .dialog
                    .is_some_and(|dialog| dialog.kind == BrowserDialogKind::BeforeUnload)
            {
                return Ok(None);
            }
            NavigationEventKind::Cancelled
        } else {
            let frame = BrowserNetworkId::new(field(params, "frameId")?)?;
            match method {
                "Page.frameStartedNavigating" => NavigationEventKind::Started(frame),
                "Page.frameStoppedLoading" => NavigationEventKind::Stopped(frame),
                _ => NavigationEventKind::SameDocument(frame),
            }
        };
        Ok(Some(NavigationEvent { source, kind }))
    }
}
