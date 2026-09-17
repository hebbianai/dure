use super::*;
use hmux_session_protocol::browser_dialog::BrowserDialogKind;
use hmux_session_protocol::browser_resource::{BrowserDialogSourceId, BrowserDocumentId};

impl Monitor {
    pub(super) async fn page_event(&mut self, event: &Value) -> Result<bool, &'static str> {
        let opening = event["method"] == "Page.javascriptDialogOpening";
        let closing = event["method"] == "Page.javascriptDialogClosed";
        let committed = event["method"] == "Page.frameNavigated";
        let detached = event["method"] == "Page.frameDetached";
        if !opening && !closing && !committed && !detached {
            return Ok(false);
        }
        let session = field(event, "sessionId")?;
        let source =
            BrowserDialogSourceId::new(session).map_err(|_| "browser_dialog_source_invalid")?;
        if closing {
            self.host
                .lock()
                .await
                .dialog_closed(&source, Instant::now())
                .map_err(|_| "browser_dialog_event_invalid")?;
            return Ok(true);
        }
        let network_source = BrowserNetworkId::new(session)?;
        let Some(target) = self
            .host
            .lock()
            .await
            .network()
            .source_target(&network_source)
            .cloned()
        else {
            // A confirmed source/page retirement can precede its last queued
            // frame event. It cannot resurrect a binding or another dialog.
            return Ok(true);
        };
        let params = &event["params"];
        let mut host = self.host.lock().await;
        let main_source = host.network().page_source(&target).as_ref() == Some(&network_source);
        if detached {
            if params["reason"] == "remove" {
                if let Some(page) = host.page_for_target(&target) {
                    let id = hmux_session_protocol::browser_resource::BrowserFrameId::new(field(
                        params, "frameId",
                    )?)
                    .map_err(|_| "browser_frame_invalid")?;
                    host.frame_removed(&page, &id)
                        .map_err(|_| "browser_frame_invalid")?;
                }
            }
            return Ok(true);
        }
        if !main_source && !committed {
            return Ok(true);
        }
        if committed {
            let frame = &params["frame"];
            if main_source && frame["parentId"].is_null() {
                let document = BrowserDocumentId::new(field(frame, "loaderId")?)
                    .map_err(|_| "browser_document_invalid")?;
                host.observe_page_document(self.instance.clone(), target.clone(), document)
                    .map_err(|_| "browser_page_invalid")?;
            }
            if let Some(page) = host.page_for_target(&target) {
                super::frames::observe_frame(&mut host, &page, frame)?;
            }
            return Ok(true);
        }
        let page = host
            .page_for_target(&target)
            .ok_or("browser_page_missing")?;
        let kind = match field(params, "type")? {
            "alert" => BrowserDialogKind::Alert,
            "confirm" => BrowserDialogKind::Confirm,
            "prompt" => BrowserDialogKind::Prompt,
            "beforeunload" => BrowserDialogKind::BeforeUnload,
            _ => return Err("browser_dialog_kind_invalid"),
        };
        host.dialog_opened(
            &page,
            source,
            kind,
            (
                field(params, "message")?,
                field(params, "url")?,
                params["defaultPrompt"].as_str().unwrap_or(""),
            ),
            Instant::now(),
        )
        .map_err(|_| "browser_dialog_event_invalid")?;
        Ok(true)
    }
}
