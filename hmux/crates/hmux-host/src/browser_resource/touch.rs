//! Touch gestures share the existing input admission and transfer boundary.
use super::{input::Purpose, *};
use hmux_session_protocol::browser_pointer::{
    BrowserTouchAction, BrowserTouchContact, TouchAction,
};

#[derive(Clone, Debug, PartialEq)]
pub(super) struct TouchState {
    page: BrowserPageIdentity,
    instance: BrowserInstanceId,
    target: BrowserTargetId,
    x: f64,
    y: f64,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> (
        BrowserResourceHost,
        BrowserControllerLease,
        BrowserPageIdentity,
    ) {
        let mut host = BrowserResourceHost::new(BrowserResourceIdentity {
            resource_id: BrowserResourceId::new("touch:test").unwrap(),
            generation: BrowserResourceGeneration::new("generation").unwrap(),
            workspace_id: BrowserWorkspaceId::new("workspace").unwrap(),
        });
        let page = host
            .register_page(
                BrowserInstanceId::new("instance").unwrap(),
                BrowserTargetId::new("target").unwrap(),
                BrowserDocumentId::new("document").unwrap(),
            )
            .unwrap();
        let lease = host
            .request_control(BrowserControllerId::new("agent").unwrap(), None)
            .unwrap()
            .controller
            .unwrap();
        (host, lease, page)
    }

    fn begin(
        host: &mut BrowserResourceHost,
        lease: &BrowserControllerLease,
        page: &BrowserPageIdentity,
    ) -> BrowserActionPermit {
        let sequence = host.projection().next_command_sequence;
        host.begin_action(
            &lease.controller_id,
            &BrowserActionAuthority {
                lease: lease.clone(),
                page: page.clone(),
                command_sequence: sequence,
                operation_id: BrowserOperationId::new(format!("touch:{sequence}")).unwrap(),
            },
            [],
        )
        .unwrap()
    }

    fn start(host: &mut BrowserResourceHost, permit: &BrowserActionPermit) {
        let event = host
            .prepare_touch(
                permit,
                TouchAction::Start { x: 200.0, y: 400.0 }
                    .try_into()
                    .unwrap(),
            )
            .unwrap();
        assert!(host.projection().touch.is_none());
        host.touch_applied(event).unwrap();
    }

    #[test]
    fn touch_cancel_acknowledgement_is_required_before_queued_control_grant() {
        let (mut host, lease, page) = setup();
        let action = begin(&mut host, &lease, &page);
        start(&mut host, &action);
        host.request_control(BrowserControllerId::new("human").unwrap(), Some(&lease))
            .unwrap();
        assert!(host.touch_release_for_transfer().unwrap().is_none());
        host.finish_action(action, BrowserActionOutcome::Completed)
            .unwrap();
        assert_eq!(host.projection().controller.as_ref(), Some(&lease));
        let cancel = host.touch_release_for_transfer().unwrap().unwrap();
        assert!(matches!(cancel.action(), TouchAction::Cancel {}));
        assert_eq!(cancel.target().as_str(), "target");
        assert!(host.projection().touch.is_some());
        host.touch_applied(cancel).unwrap();
        assert!(host.projection().touch.is_none());
        assert_eq!(
            host.projection().controller.unwrap().controller_id.as_str(),
            "human"
        );
    }

    #[test]
    fn unknown_contact_delivery_fences_the_original_instance_and_transfer() {
        for lose_start in [true, false] {
            let (mut host, lease, page) = setup();
            let action = begin(&mut host, &lease, &page);
            let event = if lose_start {
                host.prepare_touch(
                    &action,
                    TouchAction::Start { x: 1.0, y: 2.0 }.try_into().unwrap(),
                )
                .unwrap()
            } else {
                start(&mut host, &action);
                host.prepare_touch(&action, TouchAction::End {}.try_into().unwrap())
                    .unwrap()
            };
            host.touch_delivery_unknown(event).unwrap();
            assert_eq!(
                host.projection().phase,
                BrowserResourcePhase::OutcomeUnknown
            );
            assert_eq!(
                host.request_control(BrowserControllerId::new("human").unwrap(), Some(&lease)),
                Err(BrowserAdmissionError::OutcomeUnknown)
            );
            host.begin_retirement(&lease.resource).unwrap();
            host.engine_exited(&lease.resource).unwrap();
            assert!(host.projection().touch.is_none());
        }
    }

    #[test]
    fn another_page_drains_the_original_touch_before_starting_its_gesture() {
        let (mut host, lease, page) = setup();
        let action = begin(&mut host, &lease, &page);
        start(&mut host, &action);
        host.finish_action(action, BrowserActionOutcome::Completed)
            .unwrap();
        let peer = host
            .register_page(
                BrowserInstanceId::new("instance").unwrap(),
                BrowserTargetId::new("peer-target").unwrap(),
                BrowserDocumentId::new("peer-document").unwrap(),
            )
            .unwrap();
        let action = begin(&mut host, &lease, &peer);
        let proposal = TouchAction::Start { x: 20.0, y: 30.0 }.try_into().unwrap();
        assert!(matches!(
            host.prepare_touch(&action, proposal),
            Err(BrowserAdmissionError::ActionInFlight)
        ));
        let release = host
            .touch_release_before_action(&action, false)
            .unwrap()
            .unwrap();
        assert_eq!(release.target().as_str(), "target");
        host.touch_applied(release).unwrap();
        let event = host.prepare_touch(&action, proposal).unwrap();
        assert_eq!(event.target().as_str(), "peer-target");
        host.touch_applied(event).unwrap();
        host.finish_action(action, BrowserActionOutcome::Completed)
            .unwrap();
        host.request_control(BrowserControllerId::new("human").unwrap(), Some(&lease))
            .unwrap();
        host.page_closed(&peer.page_id).unwrap();
        assert!(host.projection().touch.is_none());
        assert_eq!(
            host.projection().controller.unwrap().controller_id.as_str(),
            "human"
        );
    }
}

pub struct BrowserTouchDispatch {
    resource: BrowserResourceIdentity,
    before: Option<TouchState>,
    contact: TouchState,
    action: TouchAction,
    modifiers: u8,
    purpose: Purpose,
}

impl BrowserTouchDispatch {
    pub fn target(&self) -> &BrowserTargetId {
        &self.contact.target
    }
    pub fn action(&self) -> TouchAction {
        self.action
    }
    pub fn modifiers(&self) -> u8 {
        self.modifiers
    }
}

impl BrowserResourceHost {
    pub(super) fn touch_contact(&self) -> Option<BrowserTouchContact> {
        self.touch.as_ref().map(|state| BrowserTouchContact {
            page: state.page.clone(),
        })
    }

    pub(super) fn touch_held(&self) -> bool {
        self.touch.is_some()
    }

    pub fn prepare_touch(
        &self,
        permit: &BrowserActionPermit,
        action: BrowserTouchAction,
    ) -> Result<BrowserTouchDispatch, BrowserAdmissionError> {
        self.input_action_authority(permit)?;
        let action = action.action();
        let contact = match action {
            TouchAction::Start { x, y } => {
                if self.touch.is_some() {
                    return Err(BrowserAdmissionError::ActionInFlight);
                }
                TouchState {
                    page: permit.page.clone(),
                    instance: self.instance_for_page(&permit.page.page_id)?.clone(),
                    target: self.dispatch_target(permit)?.clone(),
                    x,
                    y,
                }
            }
            TouchAction::Move { x, y } => {
                self.dispatch_frame(permit)?;
                let mut contact = self
                    .touch
                    .as_ref()
                    .ok_or(BrowserAdmissionError::PermitMismatch)?
                    .clone();
                if contact.page != permit.page {
                    return Err(BrowserAdmissionError::PermitMismatch);
                }
                contact.x = x;
                contact.y = y;
                contact
            }
            TouchAction::End {} | TouchAction::Cancel {} => {
                let contact = self
                    .touch
                    .as_ref()
                    .ok_or(BrowserAdmissionError::PermitMismatch)?;
                // Release the original contact even when its handler navigated.
                // Page replacement and destruction revoke that exact contact.
                if contact.page != permit.page {
                    return Err(BrowserAdmissionError::PermitMismatch);
                }
                contact.clone()
            }
        };
        Ok(BrowserTouchDispatch {
            resource: self.identity.clone(),
            before: self.touch.clone(),
            contact,
            action,
            modifiers: self.keyboard_modifiers(&permit.page),
            purpose: Purpose::Action(permit.operation.clone(), permit.sequence),
        })
    }

    fn touch_release(&self, purpose: Purpose) -> Option<BrowserTouchDispatch> {
        let contact = self.touch.clone()?;
        Some(BrowserTouchDispatch {
            resource: self.identity.clone(),
            before: self.touch.clone(),
            modifiers: self.keyboard_modifiers(&contact.page),
            contact,
            action: TouchAction::Cancel {},
            purpose,
        })
    }

    pub fn touch_release_before_action(
        &self,
        permit: &BrowserActionPermit,
        replaces_document: bool,
    ) -> Result<Option<BrowserTouchDispatch>, BrowserAdmissionError> {
        self.dispatch_target(permit)?;
        Ok(self
            .touch
            .as_ref()
            .filter(|state| state.page != permit.page || replaces_document)
            .and_then(|_| {
                self.touch_release(Purpose::Action(permit.operation.clone(), permit.sequence))
            }))
    }

    pub fn touch_release_for_transfer(
        &self,
    ) -> Result<Option<BrowserTouchDispatch>, BrowserAdmissionError> {
        self.require_ready()?;
        if self.input_in_flight() {
            return Ok(None);
        }
        Ok(self
            .requested_controller
            .as_ref()
            .and_then(|controller| self.touch_release(Purpose::Transfer(controller.clone()))))
    }

    fn require_touch_dispatch(
        &self,
        dispatch: &BrowserTouchDispatch,
    ) -> Result<(), BrowserAdmissionError> {
        self.require_input_purpose(&dispatch.resource, &dispatch.purpose)?;
        if self.touch != dispatch.before {
            return Err(BrowserAdmissionError::PermitMismatch);
        }
        Ok(())
    }

    pub fn touch_applied(
        &mut self,
        dispatch: BrowserTouchDispatch,
    ) -> Result<(), BrowserAdmissionError> {
        self.require_touch_dispatch(&dispatch)?;
        let revision = advance(self.revision)?;
        self.touch = match dispatch.action {
            TouchAction::Start { .. } | TouchAction::Move { .. } => Some(dispatch.contact),
            TouchAction::End {} | TouchAction::Cancel {} => None,
        };
        self.grant_drained_input_transfer()?;
        self.revision = revision;
        Ok(())
    }

    pub fn touch_delivery_unknown(
        &mut self,
        dispatch: BrowserTouchDispatch,
    ) -> Result<(), BrowserAdmissionError> {
        self.require_touch_dispatch(&dispatch)?;
        let revision = advance(self.revision)?;
        self.outcome_unknown([dispatch.contact.instance]);
        self.revision = revision;
        Ok(())
    }

    pub(super) fn touch_page_closed(
        &mut self,
        page: &BrowserPageId,
    ) -> Result<(), BrowserAdmissionError> {
        if self
            .touch
            .as_ref()
            .is_some_and(|state| &state.page.page_id == page)
        {
            self.touch = None;
        }
        self.grant_drained_input_transfer()
    }
}
