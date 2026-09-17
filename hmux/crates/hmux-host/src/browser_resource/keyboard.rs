//! Held keys share the Host's action and transfer authority with pointer input.

use super::{input::Purpose, *};
use hmux_session_protocol::browser_keyboard::{BrowserKey, BrowserKeyboardContact};

#[derive(Clone, Debug, PartialEq)]
pub(super) struct KeyboardState {
    page: BrowserPageIdentity,
    instance: BrowserInstanceId,
    target: BrowserTargetId,
    keys: Vec<BrowserKey>,
}

pub struct BrowserKeyboardDispatch {
    resource: BrowserResourceIdentity,
    before: Option<KeyboardState>,
    after: KeyboardState,
    key: BrowserKey,
    down: bool,
    repeat: bool,
    purpose: Purpose,
}

impl BrowserKeyboardDispatch {
    pub fn target(&self) -> &BrowserTargetId {
        &self.after.target
    }
    pub fn key(&self) -> &BrowserKey {
        &self.key
    }
    pub fn down(&self) -> bool {
        self.down
    }
    pub fn repeat(&self) -> bool {
        self.repeat
    }
    pub fn modifiers(&self) -> u8 {
        self.after
            .keys
            .iter()
            .fold(0, |bits, key| bits | key.modifier())
    }
}

impl BrowserResourceHost {
    pub(super) fn keyboard_contact(&self) -> Option<BrowserKeyboardContact> {
        self.keyboard.as_ref().map(|state| BrowserKeyboardContact {
            page: state.page.clone(),
            keys: state.keys.clone(),
        })
    }
    pub(super) fn keyboard_held(&self) -> bool {
        self.keyboard.is_some()
    }
    pub(super) fn keyboard_modifiers(&self, page: &BrowserPageIdentity) -> u8 {
        self.keyboard
            .as_ref()
            .filter(|state| &state.page == page)
            .map_or(0, |state| {
                state.keys.iter().fold(0, |bits, key| bits | key.modifier())
            })
    }
    pub fn key_held(&self, page: &BrowserPageIdentity, key: &BrowserKey) -> bool {
        self.keyboard.as_ref().is_some_and(|state| {
            &state.page == page && state.keys.iter().any(|held| held.same_physical_key(key))
        })
    }
    pub fn prepare_key(
        &self,
        permit: &BrowserActionPermit,
        key: BrowserKey,
        down: bool,
    ) -> Result<BrowserKeyboardDispatch, BrowserAdmissionError> {
        self.input_action_authority(permit)?;
        let held = self.key_held(&permit.page, &key);
        // A release belongs to its acknowledged press even after its handler navigates.
        let target = if !down && held {
            &self
                .pages
                .get(&permit.page.page_id)
                .ok_or(BrowserAdmissionError::PageGone)?
                .target
        } else {
            self.dispatch_target(permit)?
        };
        let mut next = match &self.keyboard {
            Some(state) if state.page == permit.page => state.clone(),
            Some(_) => return Err(BrowserAdmissionError::ActionInFlight),
            None => KeyboardState {
                page: permit.page.clone(),
                instance: self.instance_for_page(&permit.page.page_id)?.clone(),
                target: target.clone(),
                keys: Vec::new(),
            },
        };
        if down && !held {
            if next.keys.len() == 64 {
                return Err(BrowserAdmissionError::CapacityExceeded);
            }
            next.keys.push(key.clone());
        } else if !down {
            next.keys.retain(|held| !held.same_physical_key(&key));
        }
        Ok(BrowserKeyboardDispatch {
            resource: self.identity.clone(),
            before: self.keyboard.clone(),
            after: next,
            key,
            down,
            repeat: down && held,
            purpose: Purpose::Action(permit.operation.clone(), permit.sequence),
        })
    }
    fn keyboard_release(&self, purpose: Purpose) -> Option<BrowserKeyboardDispatch> {
        let mut after = self.keyboard.clone()?;
        let key = after.keys.pop()?;
        Some(BrowserKeyboardDispatch {
            resource: self.identity.clone(),
            before: self.keyboard.clone(),
            after,
            key,
            down: false,
            repeat: false,
            purpose,
        })
    }
    pub fn keyboard_release_before_action(
        &self,
        permit: &BrowserActionPermit,
        replaces_document: bool,
    ) -> Result<Option<BrowserKeyboardDispatch>, BrowserAdmissionError> {
        self.dispatch_target(permit)?;
        Ok(
            if self
                .keyboard
                .as_ref()
                .is_some_and(|state| state.page != permit.page || replaces_document)
            {
                self.keyboard_release(Purpose::Action(permit.operation.clone(), permit.sequence))
            } else {
                None
            },
        )
    }
    pub fn keyboard_release_for_transfer(
        &self,
    ) -> Result<Option<BrowserKeyboardDispatch>, BrowserAdmissionError> {
        self.require_ready()?;
        if self.input_in_flight() {
            return Ok(None);
        }
        Ok(self
            .requested_controller
            .as_ref()
            .and_then(|controller| self.keyboard_release(Purpose::Transfer(controller.clone()))))
    }
    fn require_keyboard_dispatch(
        &self,
        dispatch: &BrowserKeyboardDispatch,
    ) -> Result<(), BrowserAdmissionError> {
        self.require_input_purpose(&dispatch.resource, &dispatch.purpose)?;
        if self.keyboard != dispatch.before {
            return Err(BrowserAdmissionError::PermitMismatch);
        }
        Ok(())
    }
    pub fn keyboard_applied(
        &mut self,
        dispatch: BrowserKeyboardDispatch,
    ) -> Result<(), BrowserAdmissionError> {
        self.require_keyboard_dispatch(&dispatch)?;
        let revision = advance(self.revision)?;
        self.keyboard = if dispatch.after.keys.is_empty() {
            None
        } else {
            Some(dispatch.after)
        };
        self.grant_drained_input_transfer()?;
        self.revision = revision;
        Ok(())
    }
    pub fn keyboard_delivery_unknown(
        &mut self,
        dispatch: BrowserKeyboardDispatch,
    ) -> Result<(), BrowserAdmissionError> {
        self.require_keyboard_dispatch(&dispatch)?;
        let revision = advance(self.revision)?;
        self.outcome_unknown([dispatch.after.instance]);
        self.revision = revision;
        Ok(())
    }
    pub(super) fn keyboard_page_closed(
        &mut self,
        page: &BrowserPageId,
    ) -> Result<(), BrowserAdmissionError> {
        if self
            .keyboard
            .as_ref()
            .is_some_and(|state| &state.page.page_id == page)
        {
            self.keyboard = None;
        }
        self.grant_drained_input_transfer()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hmux_session_protocol::browser_pointer::{BrowserMouseButton, PointerAction};

    fn setup() -> (
        BrowserResourceHost,
        BrowserControllerLease,
        BrowserPageIdentity,
    ) {
        let identity = BrowserResourceIdentity {
            resource_id: BrowserResourceId::new("keyboard:test").unwrap(),
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
    ) -> BrowserActionPermit {
        let sequence = host.projection().next_command_sequence;
        host.begin_action(
            &lease.controller_id,
            &BrowserActionAuthority {
                lease: lease.clone(),
                page: page.clone(),
                command_sequence: sequence,
                operation_id: BrowserOperationId::new(format!("key:{sequence}")).unwrap(),
            },
            [],
        )
        .unwrap()
    }
    fn key(name: &str) -> BrowserKey {
        name.to_owned().try_into().unwrap()
    }
    fn down(
        host: &mut BrowserResourceHost,
        lease: &BrowserControllerLease,
        page: &BrowserPageIdentity,
        name: &str,
    ) {
        let permit = permit(host, lease, page);
        let event = host.prepare_key(&permit, key(name), true).unwrap();
        host.keyboard_applied(event).unwrap();
        host.finish_action(permit, BrowserActionOutcome::Completed)
            .unwrap();
    }

    #[test]
    fn pointer_and_both_shift_keys_drain_before_one_controller_grant() {
        let (mut host, lease, page) = setup();
        down(&mut host, &lease, &page, "ShiftLeft");
        down(&mut host, &lease, &page, "ShiftRight");
        let permit = permit(&mut host, &lease, &page);
        let pointer = host
            .prepare_pointer(
                &permit,
                PointerAction::Down {
                    button: BrowserMouseButton::Left,
                    x: None,
                    y: None,
                }
                .try_into()
                .unwrap(),
            )
            .unwrap();
        assert_eq!(pointer.modifiers(), 8);
        host.pointer_applied(pointer).unwrap();
        host.finish_action(permit, BrowserActionOutcome::Completed)
            .unwrap();
        host.request_control(BrowserControllerId::new("human").unwrap(), Some(&lease))
            .unwrap();
        let release = host.pointer_release_for_transfer().unwrap().unwrap();
        assert_eq!(release.modifiers(), 8);
        host.pointer_applied(release).unwrap();
        assert_eq!(host.projection().controller.as_ref(), Some(&lease));
        let right = host.keyboard_release_for_transfer().unwrap().unwrap();
        assert_eq!(right.key().code(), "ShiftRight");
        assert_eq!(right.modifiers(), 8);
        host.keyboard_applied(right).unwrap();
        assert_eq!(host.projection().controller.as_ref(), Some(&lease));
        let left = host.keyboard_release_for_transfer().unwrap().unwrap();
        assert_eq!(left.modifiers(), 0);
        host.keyboard_applied(left).unwrap();
        let control = host.projection();
        assert!(control.keyboard.is_none() && control.pointer.is_none());
        assert_eq!(control.controller.unwrap().controller_id.as_str(), "human");
    }

    #[test]
    fn repeat_uses_physical_key_identity_and_acknowledgement() {
        let (mut host, lease, page) = setup();
        down(&mut host, &lease, &page, "a");
        let permit = permit(&mut host, &lease, &page);
        let repeated = host.prepare_key(&permit, key("A"), true).unwrap();
        assert!(repeated.repeat());
        assert_eq!(host.projection().keyboard.unwrap().keys.len(), 1);
        host.keyboard_applied(repeated).unwrap();
        let release = host.prepare_key(&permit, key("KeyA"), false).unwrap();
        host.keyboard_applied(release).unwrap();
        assert!(host.projection().keyboard.is_none());
    }

    #[test]
    fn lost_key_release_remains_fenced_after_the_page_is_observed_closed() {
        let (mut host, lease, page) = setup();
        down(&mut host, &lease, &page, "Control");
        host.request_control(BrowserControllerId::new("human").unwrap(), Some(&lease))
            .unwrap();
        let release = host.keyboard_release_for_transfer().unwrap().unwrap();
        host.keyboard_delivery_unknown(release).unwrap();
        host.page_closed(&page.page_id).unwrap();
        assert_eq!(
            host.projection().phase,
            BrowserResourcePhase::OutcomeUnknown
        );
        assert_eq!(host.projection().controller.as_ref(), Some(&lease));
        assert!(matches!(
            host.request_control(BrowserControllerId::new("human").unwrap(), Some(&lease)),
            Err(BrowserAdmissionError::OutcomeUnknown)
        ));
    }

    #[test]
    fn a_navigation_cannot_receive_the_next_chord_key_but_its_old_press_can_release() {
        let (mut host, lease, page) = setup();
        let permit = permit(&mut host, &lease, &page);
        let shift = host.prepare_key(&permit, key("Shift"), true).unwrap();
        host.keyboard_applied(shift).unwrap();
        host.document_committed(&page.page_id, BrowserDocumentId::new("document:2").unwrap())
            .unwrap();
        assert!(matches!(
            host.prepare_key(&permit, key("a"), true),
            Err(BrowserAdmissionError::DocumentChanged)
        ));
        host.request_control(BrowserControllerId::new("human").unwrap(), Some(&lease))
            .unwrap();
        let release = host.prepare_key(&permit, key("Shift"), false).unwrap();
        host.keyboard_applied(release).unwrap();
        assert_eq!(host.projection().controller.as_ref(), Some(&lease));
        host.finish_action(permit, BrowserActionOutcome::RejectedBeforeDispatch)
            .unwrap();
        assert_eq!(
            host.projection().controller.unwrap().controller_id.as_str(),
            "human"
        );
    }
}
