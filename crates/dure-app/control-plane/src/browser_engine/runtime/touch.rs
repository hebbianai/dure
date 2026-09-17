use super::*;
use hmux_host::browser_resource::touch::BrowserTouchDispatch;
use hmux_session_protocol::browser_pointer::TouchAction;
use tokio::time::{Duration, sleep};

impl Execution<'_> {
    pub(super) async fn touch_event(
        &self,
        permit: &BrowserActionPermit,
        action: TouchAction,
    ) -> Result<(), BrowserRuntimeError> {
        let event = self
            .resource
            .host
            .lock()
            .await
            .prepare_touch(permit, action.try_into()?)?;
        self.dispatch_touch(event).await
    }

    pub(super) async fn dispatch_touch(
        &self,
        event: BrowserTouchDispatch,
    ) -> Result<(), BrowserRuntimeError> {
        let mut cdp = self.renderer_cdp(self.binding.cdp.clone(), event.target().clone());
        let (kind, points) = match event.action() {
            TouchAction::Start { x, y } => ("touchStart", json!([{"x":x,"y":y}])),
            TouchAction::Move { x, y } => ("touchMove", json!([{"x":x,"y":y}])),
            TouchAction::End {} => ("touchEnd", json!([])),
            TouchAction::Cancel {} => ("touchCancel", json!([])),
        };
        let delivered = async {
            let session = cdp.attach(event.target().as_str()).await?;
            cdp.request(
                "Input.dispatchTouchEvent",
                json!({"type":kind,"touchPoints":points,"modifiers":event.modifiers()}),
                Some(&session),
            )
            .await
        }
        .await;
        let mut host = self.resource.host.lock().await;
        match delivered {
            Ok(_) => host.touch_applied(event).map_err(|_| {
                BrowserEngineError::after("browser_touch_acknowledgement_lost").into()
            }),
            Err(_) => {
                host.touch_delivery_unknown(event)?;
                Err(BrowserEngineError::after("browser_touch_outcome_unknown").into())
            }
        }
    }

    pub(super) async fn tap_action(
        &self,
        permit: &BrowserActionPermit,
        position: &Value,
    ) -> Result<(), BrowserRuntimeError> {
        let x = position["x"].as_f64().ok_or("browser_touch_invalid")?;
        let y = position["y"].as_f64().ok_or("browser_touch_invalid")?;
        self.touch_event(permit, TouchAction::Start { x, y })
            .await?;
        self.touch_event(permit, TouchAction::End {}).await
    }

    pub(super) async fn swipe_action(
        &self,
        permit: &BrowserActionPermit,
        direction: &str,
        delta_x: f64,
        delta_y: f64,
    ) -> Result<NativeBrowserResponse, BrowserRuntimeError> {
        self.touch_event(permit, TouchAction::Start { x: 200.0, y: 400.0 })
            .await?;
        let moved: Result<(), BrowserRuntimeError> = async {
            for step in 1..=10 {
                let fraction = f64::from(step) / 10.0;
                self.touch_event(
                    permit,
                    TouchAction::Move {
                        x: 200.0 + delta_x * fraction,
                        y: 400.0 + delta_y * fraction,
                    },
                )
                .await?;
                // Pinned native swipe timing; this is gesture pacing, not retry.
                sleep(Duration::from_millis(16)).await;
            }
            Ok(())
        }
        .await;
        // End successful input; cancel a known partial gesture on its original
        // page. Unknown delivery remains fenced by Host instead of replayed.
        let released = self
            .touch_event(
                permit,
                if moved.is_ok() {
                    TouchAction::End {}
                } else {
                    TouchAction::Cancel {}
                },
            )
            .await;
        finish_swipe(direction, moved, released)
    }
}

fn finish_swipe(
    direction: &str,
    moved: Result<(), BrowserRuntimeError>,
    released: Result<(), BrowserRuntimeError>,
) -> Result<NativeBrowserResponse, BrowserRuntimeError> {
    let settled = match (moved, released) {
        (
            Err(
                error @ BrowserRuntimeError::Engine(BrowserEngineError {
                    outcome_unknown: true,
                    ..
                }),
            ),
            _,
        )
        | (
            _,
            Err(
                error @ BrowserRuntimeError::Engine(BrowserEngineError {
                    outcome_unknown: true,
                    ..
                }),
            ),
        ) => return Err(error),
        (moved, released) => released.and(moved),
    };
    find::finish_element_result(settled.map(|()| find::response(json!({"swiped":direction}))))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uncertain_release_cannot_be_hidden_by_a_known_motion_failure() {
        let result = finish_swipe(
            "up",
            Err(BrowserAdmissionError::DocumentChanged.into()),
            Err(BrowserEngineError::after("browser_touch_outcome_unknown").into()),
        );
        assert!(
            matches!(result, Err(BrowserRuntimeError::Engine(error)) if error.outcome_unknown && error.code == "browser_touch_outcome_unknown")
        );
    }

    #[test]
    fn confirmed_partial_gesture_is_not_reported_as_rejected_before_dispatch() {
        let result = finish_swipe(
            "up",
            Err(BrowserAdmissionError::DocumentChanged.into()),
            Ok(()),
        );
        assert!(result.is_ok_and(|response| !response.success));
    }

    #[test]
    fn unknown_motion_remains_unknown_when_the_fenced_release_is_refused() {
        let result = finish_swipe(
            "up",
            Err(BrowserEngineError::after("browser_touch_outcome_unknown").into()),
            Err(BrowserAdmissionError::OutcomeUnknown.into()),
        );
        assert!(matches!(result, Err(BrowserRuntimeError::Engine(error)) if error.outcome_unknown));
    }
}
