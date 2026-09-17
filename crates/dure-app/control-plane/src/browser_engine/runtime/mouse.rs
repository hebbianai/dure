use super::{BrowserActionPermit, BrowserCdp, BrowserRuntimeError, Execution};
use crate::browser_engine::{BrowserEngineError, NativeBrowserResponse};
use hmux_host::browser_resource::pointer::BrowserPointerDispatch;
use hmux_session_protocol::browser_pointer::{
    BrowserMouseButton, BrowserPointerAction, PointerAction,
};
use serde_json::{Value, json};

impl Execution<'_> {
    pub(super) async fn pointer_action(
        &self,
        permit: &BrowserActionPermit,
        action: BrowserPointerAction,
        click: u8,
    ) -> Result<NativeBrowserResponse, BrowserRuntimeError> {
        let dispatch = self
            .resource
            .host
            .lock()
            .await
            .prepare_pointer(permit, action)?;
        self.dispatch_pointer(self.binding.cdp.clone(), dispatch, click)
            .await?;
        Ok(NativeBrowserResponse {
            id: "browser-pointer".into(),
            success: true,
            data: json!({"pointer":self.resource.host.lock().await.projection().pointer}),
            error: None,
        })
    }

    pub(super) async fn dispatch_pointer(
        &self,
        cdp: BrowserCdp,
        dispatch: BrowserPointerDispatch,
        click: u8,
    ) -> Result<(), BrowserRuntimeError> {
        let mut cdp = self.renderer_cdp(cdp, dispatch.target().clone());
        let session = match cdp.attach(dispatch.target().as_str()).await {
            Ok(session) => session,
            Err(_) => {
                self.resource
                    .host
                    .lock()
                    .await
                    .pointer_delivery_unknown(dispatch)?;
                return Err(
                    BrowserEngineError::after("browser_pointer_session_unavailable").into(),
                );
            }
        };
        let (x, y) = dispatch.position();
        let buttons = dispatch.buttons();
        let primary = [
            BrowserMouseButton::Left,
            BrowserMouseButton::Right,
            BrowserMouseButton::Middle,
            BrowserMouseButton::Back,
            BrowserMouseButton::Forward,
        ]
        .into_iter()
        .find(|button| buttons & button.mask() != 0);
        let mut params = json!({"x":x,"y":y,"buttons":buttons,"modifiers":dispatch.modifiers(),"button":primary.map_or(json!("none"),|button|json!(button))});
        match dispatch.action() {
            PointerAction::Move { .. } => params["type"] = "mouseMoved".into(),
            PointerAction::Down { button, .. } | PointerAction::Up { button, .. } => {
                params["type"] = if matches!(dispatch.action(), PointerAction::Down { .. }) {
                    "mousePressed"
                } else {
                    "mouseReleased"
                }
                .into();
                params["button"] = json!(button);
                params["clickCount"] = click.into();
            }
            PointerAction::Wheel {
                delta_x, delta_y, ..
            } => {
                params["type"] = "mouseWheel".into();
                params["deltaX"] = delta_x.into();
                params["deltaY"] = delta_y.into();
            }
        }
        match cdp
            .request("Input.dispatchMouseEvent", params, Some(&session))
            .await
        {
            Ok(_) => self
                .resource
                .host
                .lock()
                .await
                .pointer_applied(dispatch)
                .map_err(|_| {
                    BrowserEngineError::after("browser_pointer_acknowledgement_lost").into()
                }),
            Err(_) => {
                self.resource
                    .host
                    .lock()
                    .await
                    .pointer_delivery_unknown(dispatch)?;
                Err(BrowserEngineError::after("browser_pointer_outcome_unknown").into())
            }
        }
    }

    pub(super) async fn element_pointer(
        &self,
        permit: &BrowserActionPermit,
        kind: &str,
        point: &Value,
        click: u8,
    ) -> Result<(), BrowserRuntimeError> {
        if kind != "mouseReleased" {
            self.resource.host.lock().await.dispatch_frame(permit)?;
        }
        let kind = match kind {
            "mouseMoved" => "move",
            "mousePressed" => "down",
            "mouseReleased" => "up",
            _ => return Err("browser_mouse_invalid".into()),
        };
        let mut action = json!({"kind":kind,"x":point["x"],"y":point["y"]});
        if kind != "move" {
            action["button"] = "left".into();
        }
        let action = serde_json::from_value(action).map_err(|_| "browser_mouse_invalid")?;
        self.pointer_action(permit, action, click).await?;
        Ok(())
    }
}

#[cfg(test)]
use super::BrowserRuntime;
#[cfg(test)]
mod tests;
