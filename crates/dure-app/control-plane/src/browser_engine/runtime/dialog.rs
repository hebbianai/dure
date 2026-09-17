//! Dialog responses bypass the ordinary engine wait but require a Host permit.

use super::*;
use hmux_session_protocol::browser_dialog::*;

impl Execution<'_> {
    pub async fn dialog(
        &self,
        page: &BrowserPageId,
    ) -> Result<BrowserDialogObservation, BrowserRuntimeError> {
        self.binding.events.synchronize_events().await?;
        Ok(self.resource.host.lock().await.dialog_observation(page)?)
    }

    pub async fn respond_dialog(
        &self,
        caller: &BrowserControllerId,
        authority: &BrowserActionAuthority,
        dialog: &BrowserDialogIdentity,
        response: BrowserDialogResponse,
    ) -> Result<BrowserActionResult, BrowserRuntimeError> {
        self.binding.events.synchronize_events().await?;
        let permit = self
            .resource
            .host
            .lock()
            .await
            .begin_dialog_response(caller, authority, dialog, response)?;
        let dispatched: Result<_, BrowserRuntimeError> = async {
            let source = self.resource.host.lock().await.dispatch_dialog(&permit)?.clone();
            let mut params = match permit.response() {
                BrowserDialogResponse::Accept { .. } => json!({"accept":true}),
                BrowserDialogResponse::Dismiss {} => json!({"accept":false}),
            };
            if let BrowserDialogResponse::Accept { text: Some(text) } = permit.response() {
                params["promptText"] = text.as_str().into();
            }
            self.binding.events.cdp.clone().request("Page.handleJavaScriptDialog",params,Some(source.as_str())).await.map_err(|code| {
                if code == "browser_cdp_request_rejected" { BrowserEngineError::before("browser_dialog_rejected") }
                else { BrowserEngineError::after("browser_dialog_response_unknown") }
            })?;
            self.binding.events.synchronize_events().await.map_err(|_|BrowserEngineError::after("browser_dialog_observation_lost"))?;
            Ok(NativeBrowserResponse { id:"browser-dialog".into(), success:true, data:json!({"dialog":dialog,"accepted":matches!(permit.response(),BrowserDialogResponse::Accept { .. })}), error:None })
        }.await;
        let outcome = match &dispatched {
            Ok(_) => BrowserActionOutcome::Completed,
            Err(BrowserRuntimeError::Engine(error)) if error.outcome_unknown => {
                BrowserActionOutcome::OutcomeUnknown
            }
            Err(_) => BrowserActionOutcome::RejectedBeforeDispatch,
        };
        self.resource
            .host
            .lock()
            .await
            .finish_dialog_response(permit, outcome)?;
        self.binding.events.changed.notify_waiters();
        // Whichever completion clears the last input permit must drain held
        // contacts. The triggering input may have finished while this response
        // was still in flight; it could not release them or grant control then.
        if outcome == BrowserActionOutcome::Completed {
            let _ = self.resource.drain_input_transfer().await;
        }
        let control = self.resource.control().await;
        Ok(BrowserActionResult {
            response: dispatched?,
            control,
            observation: None,
        })
    }
}
