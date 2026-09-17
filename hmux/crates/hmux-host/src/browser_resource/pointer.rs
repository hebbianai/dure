//! One pointer state for raw coordinates, located elements and gesture draining.

use super::{input::Purpose, *};
use hmux_session_protocol::browser_pointer::{
    BrowserMouseButton, BrowserPointerAction, BrowserPointerContact, PointerAction,
};

#[derive(Clone, Debug, PartialEq)]
pub(super) struct PointerState {
    pub(super) page: BrowserPageIdentity,
    instance: BrowserInstanceId,
    target: BrowserTargetId,
    x: f64,
    y: f64,
    buttons: u8,
}

/// A single planned engine event. Only its matching acknowledgement advances
/// the Host state; an uncertain delivery fences the resource.
pub struct BrowserPointerDispatch {
    resource: BrowserResourceIdentity,
    before: Option<PointerState>,
    after: PointerState,
    action: PointerAction,
    modifiers: u8,
    purpose: Purpose,
}

impl BrowserPointerDispatch {
    pub fn target(&self) -> &BrowserTargetId {
        &self.after.target
    }
    pub fn action(&self) -> PointerAction {
        self.action
    }
    pub fn position(&self) -> (f64, f64) {
        (self.after.x, self.after.y)
    }
    pub fn modifiers(&self) -> u8 {
        self.modifiers
    }
    pub fn buttons(&self) -> u8 {
        self.after.buttons
    }
}

impl BrowserResourceHost {
    pub(super) fn pointer_contact(&self) -> Option<BrowserPointerContact> {
        self.pointer.as_ref().map(|state| BrowserPointerContact {
            page: state.page.clone(),
            buttons: state.buttons,
        })
    }

    pub(super) fn pointer_held(&self) -> bool {
        self.pointer
            .as_ref()
            .is_some_and(|state| state.buttons != 0)
    }

    pub fn prepare_pointer(
        &self,
        permit: &BrowserActionPermit,
        action: BrowserPointerAction,
    ) -> Result<BrowserPointerDispatch, BrowserAdmissionError> {
        self.input_action_authority(permit)?;
        let action = action.action();
        // A known press must still be released if its handler navigated the
        // document or invalidated the element. It never targets another tab.
        let releases_known_press = matches!(action, PointerAction::Up { button, .. } if self.pointer.as_ref().is_some_and(|state| state.page == permit.page && state.buttons & button.mask() != 0));
        let target = if releases_known_press {
            &self
                .pages
                .get(&permit.page.page_id)
                .ok_or(BrowserAdmissionError::PageGone)?
                .target
        } else {
            self.dispatch_target(permit)?
        };
        let mut next = match &self.pointer {
            Some(state) if state.page == permit.page => state.clone(),
            Some(state) if state.buttons != 0 => return Err(BrowserAdmissionError::ActionInFlight),
            _ => PointerState {
                page: permit.page.clone(),
                instance: self.instance_for_page(&permit.page.page_id)?.clone(),
                target: target.clone(),
                x: 0.0,
                y: 0.0,
                buttons: 0,
            },
        };
        match action {
            PointerAction::Move { x, y } => {
                next.x = x;
                next.y = y;
            }
            PointerAction::Down { button, x, y } => {
                if let (Some(x), Some(y)) = (x, y) {
                    next.x = x;
                    next.y = y;
                }
                next.buttons |= button.mask();
            }
            PointerAction::Up { button, x, y } => {
                if let (Some(x), Some(y)) = (x, y) {
                    next.x = x;
                    next.y = y;
                }
                next.buttons &= !button.mask();
            }
            PointerAction::Wheel { x, y, .. } => {
                if let (Some(x), Some(y)) = (x, y) {
                    next.x = x;
                    next.y = y;
                }
            }
        }
        Ok(BrowserPointerDispatch {
            resource: self.identity.clone(),
            before: self.pointer.clone(),
            after: next,
            action,
            modifiers: self.keyboard_modifiers(&permit.page),
            purpose: Purpose::Action(permit.operation.clone(), permit.sequence),
        })
    }

    fn pointer_release(&self, purpose: Purpose) -> Option<BrowserPointerDispatch> {
        let state = self.pointer.as_ref()?;
        let button = [
            BrowserMouseButton::Left,
            BrowserMouseButton::Right,
            BrowserMouseButton::Middle,
            BrowserMouseButton::Back,
            BrowserMouseButton::Forward,
        ]
        .into_iter()
        .find(|button| state.buttons & button.mask() != 0)?;
        let mut next = state.clone();
        next.buttons &= !button.mask();
        Some(BrowserPointerDispatch {
            resource: self.identity.clone(),
            before: self.pointer.clone(),
            after: next,
            action: PointerAction::Up {
                button,
                x: None,
                y: None,
            },
            modifiers: self.keyboard_modifiers(&state.page),
            purpose,
        })
    }

    /// Finish contacts on their original target before selecting a different
    /// document or performing an explicit navigation/close operation.
    pub fn pointer_release_before_action(
        &self,
        permit: &BrowserActionPermit,
        replaces_document: bool,
    ) -> Result<Option<BrowserPointerDispatch>, BrowserAdmissionError> {
        self.dispatch_target(permit)?;
        if self
            .pointer
            .as_ref()
            .is_some_and(|state| state.page != permit.page || replaces_document)
        {
            Ok(self.pointer_release(Purpose::Action(permit.operation.clone(), permit.sequence)))
        } else {
            Ok(None)
        }
    }

    pub fn pointer_release_for_transfer(
        &self,
    ) -> Result<Option<BrowserPointerDispatch>, BrowserAdmissionError> {
        self.require_ready()?;
        if self.input_in_flight() {
            return Ok(None);
        }
        Ok(self
            .requested_controller
            .as_ref()
            .and_then(|controller| self.pointer_release(Purpose::Transfer(controller.clone()))))
    }

    fn require_pointer_dispatch(
        &self,
        dispatch: &BrowserPointerDispatch,
    ) -> Result<(), BrowserAdmissionError> {
        self.require_input_purpose(&dispatch.resource, &dispatch.purpose)?;
        if self.pointer != dispatch.before {
            return Err(BrowserAdmissionError::PermitMismatch);
        }
        Ok(())
    }

    pub fn pointer_applied(
        &mut self,
        dispatch: BrowserPointerDispatch,
    ) -> Result<(), BrowserAdmissionError> {
        self.require_pointer_dispatch(&dispatch)?;
        let revision = advance(self.revision)?;
        self.pointer = Some(dispatch.after);
        self.grant_drained_input_transfer()?;
        self.revision = revision;
        Ok(())
    }

    pub fn pointer_delivery_unknown(
        &mut self,
        dispatch: BrowserPointerDispatch,
    ) -> Result<(), BrowserAdmissionError> {
        self.require_pointer_dispatch(&dispatch)?;
        let revision = advance(self.revision)?;
        self.outcome_unknown([dispatch.after.instance]);
        self.revision = revision;
        Ok(())
    }

    pub(super) fn pointer_page_closed(
        &mut self,
        page: &BrowserPageId,
    ) -> Result<(), BrowserAdmissionError> {
        if self
            .pointer
            .as_ref()
            .is_some_and(|state| &state.page.page_id == page)
        {
            self.pointer = None;
        }
        self.grant_drained_input_transfer()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> (
        BrowserResourceHost,
        BrowserControllerLease,
        BrowserPageIdentity,
    ) {
        let identity = BrowserResourceIdentity {
            resource_id: BrowserResourceId::new("pointer:test").unwrap(),
            generation: BrowserResourceGeneration::new("generation:1").unwrap(),
            workspace_id: BrowserWorkspaceId::new("workspace:1").unwrap(),
        };
        let mut host = BrowserResourceHost::new(identity);
        let page = host
            .register_page(
                BrowserInstanceId::new("instance").unwrap(),
                BrowserTargetId::new("target:1").unwrap(),
                BrowserDocumentId::new("document:1").unwrap(),
            )
            .unwrap();
        let lease = host
            .request_control(BrowserControllerId::new("agent").unwrap(), None)
            .unwrap()
            .controller
            .unwrap();
        (host, lease, page)
    }

    fn permit(
        host: &mut BrowserResourceHost,
        lease: &BrowserControllerLease,
        page: &BrowserPageIdentity,
    ) -> Result<BrowserActionPermit, BrowserAdmissionError> {
        let sequence = host.projection().next_command_sequence;
        host.begin_action(
            &lease.controller_id,
            &BrowserActionAuthority {
                lease: lease.clone(),
                page: page.clone(),
                command_sequence: sequence,
                operation_id: BrowserOperationId::new(format!("pointer:{sequence}")).unwrap(),
            },
            [],
        )
    }

    fn press(
        host: &mut BrowserResourceHost,
        lease: &BrowserControllerLease,
        page: &BrowserPageIdentity,
        button: BrowserMouseButton,
    ) {
        let permit = permit(host, lease, page).unwrap();
        let dispatch = host
            .prepare_pointer(
                &permit,
                PointerAction::Down {
                    button,
                    x: None,
                    y: None,
                }
                .try_into()
                .unwrap(),
            )
            .unwrap();
        host.pointer_applied(dispatch).unwrap();
        host.finish_action(permit, BrowserActionOutcome::Completed)
            .unwrap();
    }

    #[test]
    fn positioned_wheel_updates_only_the_acknowledged_admitted_pointer() {
        let (mut host, lease, page) = setup();
        let wheel = permit(&mut host, &lease, &page).unwrap();
        let action = serde_json::from_value(serde_json::json!({
            "kind":"wheel","x":123.5,"y":321.0,"delta_x":2.0,"delta_y":40.0
        }))
        .unwrap();
        let dispatch = host.prepare_pointer(&wheel, action).unwrap();
        assert_eq!(dispatch.position(), (123.5, 321.0));
        assert!(host.projection().pointer.is_none());
        host.pointer_applied(dispatch).unwrap();
        host.finish_action(wheel, BrowserActionOutcome::Completed)
            .unwrap();
        let next = permit(&mut host, &lease, &page).unwrap();
        let legacy =
            serde_json::from_value(serde_json::json!({"kind":"wheel","delta_y":10})).unwrap();
        let dispatch = host.prepare_pointer(&next, legacy).unwrap();
        assert_eq!(dispatch.position(), (123.5, 321.0));
        host.pointer_delivery_unknown(dispatch).unwrap();
        assert_eq!(
            host.projection().phase,
            BrowserResourcePhase::OutcomeUnknown
        );
    }

    #[test]
    fn handoff_waits_for_every_held_button_to_be_acknowledged() {
        let (mut host, lease, page) = setup();
        press(&mut host, &lease, &page, BrowserMouseButton::Left);
        press(&mut host, &lease, &page, BrowserMouseButton::Right);
        let pending = host
            .request_control(BrowserControllerId::new("human").unwrap(), Some(&lease))
            .unwrap();
        assert_eq!(pending.controller.as_ref(), Some(&lease));
        assert_eq!(pending.pointer.unwrap().buttons, 3);
        assert!(matches!(
            permit(&mut host, &lease, &page),
            Err(BrowserAdmissionError::ControlTransferPending)
        ));
        let first = host.pointer_release_for_transfer().unwrap().unwrap();
        assert_eq!(first.buttons(), 2);
        assert_eq!(host.projection().pointer.unwrap().buttons, 3);
        host.pointer_applied(first).unwrap();
        assert_eq!(host.projection().controller.as_ref(), Some(&lease));
        let last = host.pointer_release_for_transfer().unwrap().unwrap();
        assert_eq!(last.buttons(), 0);
        host.pointer_applied(last).unwrap();
        let granted = host.projection();
        assert_eq!(granted.controller.unwrap().controller_id.as_str(), "human");
        assert!(granted.pointer.is_none());
        assert!(granted.requested_controller.is_none());
    }

    #[test]
    fn unknown_pointer_release_cannot_grant_or_resume_a_controller() {
        let (mut host, lease, page) = setup();
        press(&mut host, &lease, &page, BrowserMouseButton::Left);
        host.request_control(BrowserControllerId::new("human").unwrap(), Some(&lease))
            .unwrap();
        let release = host.pointer_release_for_transfer().unwrap().unwrap();
        host.pointer_delivery_unknown(release).unwrap();
        assert_eq!(
            host.projection().phase,
            BrowserResourcePhase::OutcomeUnknown
        );
        assert_eq!(host.projection().controller.as_ref(), Some(&lease));
        assert!(matches!(
            permit(&mut host, &lease, &page),
            Err(BrowserAdmissionError::OutcomeUnknown)
        ));
        assert_eq!(
            host.request_control(BrowserControllerId::new("human").unwrap(), Some(&lease)),
            Err(BrowserAdmissionError::OutcomeUnknown)
        );
        host.page_closed(&page.page_id).unwrap();
        assert_eq!(host.projection().controller.as_ref(), Some(&lease));
        host.begin_retirement(&lease.resource).unwrap();
        host.engine_exited(&lease.resource).unwrap();
        assert!(host.projection().pointer.is_none());
        assert_eq!(host.projection().phase, BrowserResourcePhase::Closed);
    }

    #[test]
    fn located_and_raw_events_share_position_and_drain_the_original_page() {
        let (mut host, lease, page) = setup();
        let movement = permit(&mut host, &lease, &page).unwrap();
        let dispatch = host
            .prepare_pointer(
                &movement,
                PointerAction::Move { x: 250.0, y: 130.0 }
                    .try_into()
                    .unwrap(),
            )
            .unwrap();
        host.pointer_applied(dispatch).unwrap();
        host.finish_action(movement, BrowserActionOutcome::Completed)
            .unwrap();
        let down = permit(&mut host, &lease, &page).unwrap();
        let dispatch = host
            .prepare_pointer(
                &down,
                PointerAction::Down {
                    button: BrowserMouseButton::Left,
                    x: None,
                    y: None,
                }
                .try_into()
                .unwrap(),
            )
            .unwrap();
        assert_eq!(dispatch.position(), (250.0, 130.0));
        host.pointer_applied(dispatch).unwrap();
        host.finish_action(down, BrowserActionOutcome::Completed)
            .unwrap();
        let peer = host
            .register_page(
                BrowserInstanceId::new("instance").unwrap(),
                BrowserTargetId::new("target:2").unwrap(),
                BrowserDocumentId::new("document:2").unwrap(),
            )
            .unwrap();
        let moved = permit(&mut host, &lease, &peer).unwrap();
        let action = PointerAction::Down {
            button: BrowserMouseButton::Left,
            x: None,
            y: None,
        }
        .try_into()
        .unwrap();
        assert!(matches!(
            host.prepare_pointer(&moved, action),
            Err(BrowserAdmissionError::ActionInFlight)
        ));
        let release = host
            .pointer_release_before_action(&moved, false)
            .unwrap()
            .unwrap();
        assert_eq!(release.target().as_str(), "target:1");
        host.pointer_applied(release).unwrap();
        let peer_press = host.prepare_pointer(&moved, action).unwrap();
        assert_eq!(peer_press.target().as_str(), "target:2");
        assert_eq!(peer_press.position(), (0.0, 0.0));
        host.pointer_applied(peer_press).unwrap();
        host.finish_action(moved, BrowserActionOutcome::Completed)
            .unwrap();
    }

    #[test]
    fn observed_page_exit_retires_its_contact_before_granting_pending_control() {
        let (mut host, lease, page) = setup();
        press(&mut host, &lease, &page, BrowserMouseButton::Left);
        host.request_control(BrowserControllerId::new("human").unwrap(), Some(&lease))
            .unwrap();
        host.page_closed(&page.page_id).unwrap();
        assert!(host.pointer_release_for_transfer().unwrap().is_none());
        assert!(host.projection().pointer.is_none());
        assert_eq!(
            host.projection().controller.unwrap().controller_id.as_str(),
            "human"
        );
    }
}
