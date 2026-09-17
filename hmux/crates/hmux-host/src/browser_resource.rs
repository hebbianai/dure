//! One browser resource's live page bindings and serialized input authority.
//!
//! The embedding transport authenticates callers. The engine adapter owns CDP
//! and process operations; it may dispatch a mutation only with an issued permit.

use hmux_session_protocol::browser_resource::*;
use std::collections::{BTreeMap, BTreeSet};
use std::num::NonZeroU64;
use std::time::{Duration, Instant};

const MAX_LIVE_PAGES: usize = 128;
const MAX_SNAPSHOT_ELEMENTS: usize = 16_384;

pub mod console;
pub mod creation;
pub mod dialog;
mod frames;
mod headers;
mod input;
mod instances;
mod interception;
pub mod keyboard;
mod labels;
mod navigation;
mod network_capture;
mod outcomes;
pub mod pointer;
pub mod recording;
pub mod replacement;
mod selection;
mod storage;
mod targets;
pub mod touch;
pub mod tracing;

pub use navigation::BrowserNavigationPermit;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BrowserAdmissionError {
    ResourceMismatch,
    InstanceMismatch,
    PageGone,
    DocumentChanged,
    SnapshotChanged,
    ElementNotObserved,
    ControllerChanged,
    CallerMismatch,
    ControlTransferPending,
    ActionInFlight,
    CommandAlreadyDispatched,
    CommandSequenceGap,
    OutcomeUnknown,
    ResourceRetiring,
    ResourceClosed,
    CapacityExceeded,
    RevisionExhausted,
    PermitMismatch,
    DialogChanged,
    DialogResponseInvalid,
    DialogObservationLost,
    FrameGone,
    FrameChanged,
    RecordingAlreadyActive,
    RecordingNotActive,
    TracingAlreadyActive,
    TracingNotActive,
    TracingScopeRequired,
    PageLabelTaken,
}

struct PageState {
    label: Option<BrowserPageLabel>,
    storage_origins: storage::StorageOrigins,
    recording: Option<recording::RecordingState>,
    frames: frames::Frames,
    instance: BrowserInstanceId,
    dialog_observation_lost: bool,
    request_headers: std::collections::BTreeMap<String, String>,
    interception: interception::PageInterception,
    execution_started: Instant,
    dialog_wait: Duration,
    target: BrowserTargetId,
    document: BrowserDocumentId,
    document_revision: NonZeroU64,
    snapshot_revision: Option<NonZeroU64>,
    elements: BTreeSet<BrowserElementId>,
}

struct ActiveAction {
    operation: BrowserOperationId,
    sequence: NonZeroU64,
    page: Option<BrowserPageId>,
    instance: BrowserInstanceId,
    page_creation: Option<creation::PageCreation>,
    creation_label: Option<BrowserPageLabel>,
}

/// An owned proof of one admitted dispatch. It cannot be cloned or deserialized.
pub struct BrowserActionPermit {
    resource: BrowserResourceIdentity,
    operation: BrowserOperationId,
    sequence: NonZeroU64,
    page: BrowserPageIdentity,
    references: Vec<BrowserElementReference>,
    frame_revision: NonZeroU64,
}

pub struct BrowserResourceHost {
    pub(super) network: crate::browser_network::BrowserNetworkHost,
    identity: BrowserResourceIdentity,
    phase: outcomes::Phase,
    revision: NonZeroU64,
    next_page: NonZeroU64,
    next_snapshot: NonZeroU64,
    next_control_epoch: NonZeroU64,
    next_command: NonZeroU64,
    instances: BTreeMap<BrowserInstanceId, instances::InstanceState>,
    pages: BTreeMap<BrowserPageId, PageState>,
    selection: Option<selection::InputSelection>,
    reserved_targets: BTreeMap<BrowserTargetId, targets::TargetReservation>,
    controller: Option<BrowserControllerLease>,
    requested_controller: Option<BrowserControllerId>,
    active: Option<ActiveAction>,
    pointer: Option<pointer::PointerState>,
    keyboard: Option<keyboard::KeyboardState>,
    touch: Option<touch::TouchState>,
    dialogs: dialog::DialogState,
    console: console::ConsoleState,
}

fn advance(value: NonZeroU64) -> Result<NonZeroU64, BrowserAdmissionError> {
    value
        .checked_add(1)
        .ok_or(BrowserAdmissionError::RevisionExhausted)
}

impl BrowserResourceHost {
    pub fn new(identity: BrowserResourceIdentity) -> Self {
        Self {
            network: Default::default(),
            identity,
            phase: outcomes::Phase::Ready,
            revision: NonZeroU64::MIN,
            next_page: NonZeroU64::MIN,
            next_snapshot: NonZeroU64::MIN,
            next_control_epoch: NonZeroU64::MIN,
            next_command: NonZeroU64::MIN,
            instances: BTreeMap::new(),
            pages: BTreeMap::new(),
            selection: None,
            reserved_targets: BTreeMap::new(),
            controller: None,
            requested_controller: None,
            active: None,
            pointer: None,
            keyboard: None,
            touch: None,
            dialogs: Default::default(),
            console: Default::default(),
        }
    }

    /// Observation does not acquire input authority or change resource lifetime.
    pub fn projection(&self) -> BrowserControlProjection {
        BrowserControlProjection {
            resource: self.identity.clone(),
            revision: self.revision,
            phase: self.phase.projection(),
            controller: self.controller.clone(),
            requested_controller: self.requested_controller.clone(),
            in_flight: self.active.as_ref().map(|action| action.operation.clone()),
            next_command_sequence: self.next_command,
            current_page: self.current_page(),
            pointer: self.pointer_contact(),
            keyboard: self.keyboard_contact(),
            touch: self.touch_contact(),
            dialog_response: self.dialogs.response_operation(),
        }
    }

    fn require_identity(
        &self,
        resource: &BrowserResourceIdentity,
    ) -> Result<(), BrowserAdmissionError> {
        if resource != &self.identity {
            return Err(BrowserAdmissionError::ResourceMismatch);
        }
        Ok(())
    }

    fn require_ready(&self) -> Result<(), BrowserAdmissionError> {
        match self.phase.projection() {
            BrowserResourcePhase::Ready => Ok(()),
            BrowserResourcePhase::OutcomeUnknown => Err(BrowserAdmissionError::OutcomeUnknown),
            BrowserResourcePhase::Retiring => Err(BrowserAdmissionError::ResourceRetiring),
            BrowserResourcePhase::Closed => Err(BrowserAdmissionError::ResourceClosed),
        }
    }

    pub fn register_page(
        &mut self,
        instance: BrowserInstanceId,
        target: BrowserTargetId,
        document: BrowserDocumentId,
    ) -> Result<BrowserPageIdentity, BrowserAdmissionError> {
        self.require_ready()?;
        self.require_instance_registration(&instance)?;
        if self
            .reserved_targets
            .get(&target)
            .is_some_and(|owner| owner.instance != instance)
        {
            return Err(BrowserAdmissionError::InstanceMismatch);
        }
        if self.page_target_is_retiring(&target) {
            return Err(BrowserAdmissionError::ResourceRetiring);
        }
        if self
            .reserved_targets
            .get(&target)
            .is_some_and(|owner| matches!(owner.kind, targets::ReservationKind::Replacement(_)))
        {
            return Err(BrowserAdmissionError::PermitMismatch);
        }
        if (!self.reserved_targets.contains_key(&target)
            && self.live_page_capacity() >= MAX_LIVE_PAGES)
            || self.pages.values().any(|page| page.target == target)
        {
            return Err(BrowserAdmissionError::CapacityExceeded);
        }
        let next_page = advance(self.next_page)?;
        let revision = advance(self.revision)?;
        let page_id = BrowserPageId::new(format!("page:{}", self.next_page))
            .expect("Host-issued page ID is bounded ASCII");
        self.instances
            .insert(instance.clone(), instances::InstanceState::Active);
        let label = self
            .reserved_targets
            .remove(&target)
            .and_then(|owner| owner.label);
        let mut page = PageState::new(instance, target, document, NonZeroU64::MIN);
        page.label = label;
        self.pages.insert(page_id.clone(), page);
        if self.selection.is_none() {
            self.selection = Some(selection::InputSelection::Page(page_id.clone()));
        }
        self.next_page = next_page;
        self.revision = revision;
        self.page_identity(&page_id)
    }

    pub fn page_identity(
        &self,
        page_id: &BrowserPageId,
    ) -> Result<BrowserPageIdentity, BrowserAdmissionError> {
        let page = self
            .pages
            .get(page_id)
            .ok_or(BrowserAdmissionError::PageGone)?;
        Ok(BrowserPageIdentity {
            resource: self.identity.clone(),
            page_id: page_id.clone(),
            document_revision: page.document_revision,
        })
    }

    pub fn pages(&self) -> Vec<BrowserPageIdentity> {
        self.pages
            .keys()
            .map(|id| {
                self.page_identity(id)
                    .expect("registered page remains present")
            })
            .collect()
    }

    pub fn page_for_target(&self, target: &BrowserTargetId) -> Option<BrowserPageIdentity> {
        self.pages
            .iter()
            .find(|(_, page)| &page.target == target)
            .map(|(id, _)| {
                self.page_identity(id)
                    .expect("registered page remains present")
            })
    }

    /// The adapter reports invalidation of observed refs, including an explicit
    /// page selection. Consumers cannot retain refs across that transition.
    pub fn element_table_replaced(&mut self) -> Result<(), BrowserAdmissionError> {
        let revision = advance(self.revision)?;
        for page in self.pages.values_mut() {
            page.snapshot_revision = None;
            page.elements.clear();
        }
        self.revision = revision;
        Ok(())
    }

    pub fn target_for(
        &self,
        page: &BrowserPageIdentity,
    ) -> Result<&BrowserTargetId, BrowserAdmissionError> {
        self.require_identity(&page.resource)?;
        let current = self
            .pages
            .get(&page.page_id)
            .ok_or(BrowserAdmissionError::PageGone)?;
        if current.document_revision != page.document_revision {
            return Err(BrowserAdmissionError::DocumentChanged);
        }
        self.require_active_instance(&current.instance)?;
        Ok(&current.target)
    }

    /// The adapter calls this for a main-document commit, not URL-only changes.
    pub fn document_committed(
        &mut self,
        page_id: &BrowserPageId,
        document: BrowserDocumentId,
    ) -> Result<BrowserPageIdentity, BrowserAdmissionError> {
        let page = self
            .pages
            .get_mut(page_id)
            .ok_or(BrowserAdmissionError::PageGone)?;
        if page.document != document {
            let document_revision = advance(page.document_revision)?;
            let revision = advance(self.revision)?;
            page.document = document;
            page.document_revision = document_revision;
            page.frames = Default::default();
            page.snapshot_revision = None;
            page.elements.clear();
            self.revision = revision;
            page.dialog_wait += self.dialogs.remove_page(page_id, Instant::now());
            if !self.pointer_held()
                && self
                    .pointer
                    .as_ref()
                    .is_some_and(|state| &state.page.page_id == page_id)
            {
                self.pointer = None;
            }
        }
        self.page_identity(page_id)
    }

    pub fn page_closed(&mut self, page_id: &BrowserPageId) -> Result<(), BrowserAdmissionError> {
        if !self.pages.contains_key(page_id) {
            return Err(BrowserAdmissionError::PageGone);
        }
        let revision = advance(self.revision)?;
        if let Some(page) = self.pages.remove(page_id) {
            self.selection_page_closed(page_id, &page.instance);
            self.network.remove_page(&page.target);
        }
        self.console.remove_page(page_id);
        self.pointer_page_closed(page_id)?;
        self.dialogs.remove_page(page_id, Instant::now());
        self.keyboard_page_closed(page_id)?;
        self.touch_page_closed(page_id)?;
        self.revision = revision;
        Ok(())
    }

    pub fn snapshot_observed(
        &mut self,
        page: &BrowserPageIdentity,
        elements: BTreeSet<BrowserElementId>,
    ) -> Result<BrowserSnapshotIdentity, BrowserAdmissionError> {
        self.target_for(page)?;
        if elements.len() > MAX_SNAPSHOT_ELEMENTS {
            return Err(BrowserAdmissionError::CapacityExceeded);
        }
        let next = advance(self.next_snapshot)?;
        let revision = advance(self.revision)?;
        let snapshot = BrowserSnapshotIdentity {
            page: page.clone(),
            revision: self.next_snapshot,
        };
        let current = self
            .pages
            .get_mut(&page.page_id)
            .expect("validated page remains present");
        current.snapshot_revision = Some(self.next_snapshot);
        current.elements = elements;
        self.next_snapshot = next;
        self.revision = revision;
        Ok(snapshot)
    }

    pub fn validate_element<'a>(
        &self,
        reference: &'a BrowserElementReference,
    ) -> Result<&'a BrowserElementId, BrowserAdmissionError> {
        self.target_for(&reference.snapshot.page)?;
        let page = self
            .pages
            .get(&reference.snapshot.page.page_id)
            .expect("validated page remains present");
        if page.snapshot_revision != Some(reference.snapshot.revision) {
            return Err(BrowserAdmissionError::SnapshotChanged);
        }
        if !page.elements.contains(&reference.element) {
            return Err(BrowserAdmissionError::ElementNotObserved);
        }
        Ok(&reference.element)
    }

    fn grant_control(
        &mut self,
        controller: BrowserControllerId,
    ) -> Result<(), BrowserAdmissionError> {
        let next = advance(self.next_control_epoch)?;
        self.controller = Some(BrowserControllerLease {
            resource: self.identity.clone(),
            controller_id: controller,
            epoch: self.next_control_epoch,
        });
        self.next_control_epoch = next;
        self.requested_controller = None;
        self.pointer = None;
        self.keyboard = None;
        self.touch = None;
        for page in self.pages.values_mut() {
            page.snapshot_revision = None;
            page.elements.clear();
        }
        Ok(())
    }

    /// Authentication and permission to request this principal precede this call.
    /// A pending transfer immediately fences new input and drains one active action.
    pub fn request_control(
        &mut self,
        controller: BrowserControllerId,
        expected: Option<&BrowserControllerLease>,
    ) -> Result<BrowserControlProjection, BrowserAdmissionError> {
        self.require_ready()?;
        if self.controller.as_ref() != expected {
            return Err(BrowserAdmissionError::ControllerChanged);
        }
        if self.requested_controller.is_some() {
            return Err(BrowserAdmissionError::ControlTransferPending);
        }
        if self
            .controller
            .as_ref()
            .is_some_and(|lease| lease.controller_id == controller)
        {
            return Ok(self.projection());
        }
        let revision = advance(self.revision)?;
        advance(self.next_control_epoch)?;
        if self.input_in_flight()
            || self.pointer_held()
            || self.keyboard_held()
            || self.touch_held()
        {
            self.requested_controller = Some(controller);
        } else {
            self.grant_control(controller)?;
        }
        self.revision = revision;
        Ok(self.projection())
    }

    pub fn begin_action<'a>(
        &mut self,
        caller: &BrowserControllerId,
        authority: &BrowserActionAuthority,
        references: impl IntoIterator<Item = &'a BrowserElementReference>,
    ) -> Result<BrowserActionPermit, BrowserAdmissionError> {
        self.require_action_admission(caller, &authority.lease, authority.command_sequence)?;
        self.target_for(&authority.page)?;
        let mut admitted_references = Vec::new();
        for reference in references {
            if admitted_references.len() >= MAX_SNAPSHOT_ELEMENTS {
                return Err(BrowserAdmissionError::CapacityExceeded);
            }
            if reference.snapshot.page != authority.page {
                return Err(BrowserAdmissionError::DocumentChanged);
            }
            self.validate_element(reference)?;
            admitted_references.push(reference.clone());
        }
        self.admit_action(ActiveAction {
            operation: authority.operation_id.clone(),
            sequence: authority.command_sequence,
            page: Some(authority.page.page_id.clone()),
            instance: self.instance_for_page(&authority.page.page_id)?.clone(),
            page_creation: None,
            creation_label: None,
        })?;
        Ok(BrowserActionPermit {
            resource: self.identity.clone(),
            operation: authority.operation_id.clone(),
            sequence: authority.command_sequence,
            page: authority.page.clone(),
            references: admitted_references,
            frame_revision: self.pages[&authority.page.page_id].frames.revision,
        })
    }

    fn require_action_admission(
        &self,
        caller: &BrowserControllerId,
        lease: &BrowserControllerLease,
        sequence: NonZeroU64,
    ) -> Result<(), BrowserAdmissionError> {
        self.require_controller(caller, lease)?;
        if self.requested_controller.is_some() {
            return Err(BrowserAdmissionError::ControlTransferPending);
        }
        self.require_command_sequence(sequence)?;
        if self.input_in_flight() {
            return Err(BrowserAdmissionError::ActionInFlight);
        }
        Ok(())
    }

    fn admit_action(&mut self, action: ActiveAction) -> Result<(), BrowserAdmissionError> {
        let next = advance(self.next_command)?;
        let revision = advance(self.revision)?;
        self.active = Some(action);
        self.next_command = next;
        self.revision = revision;
        Ok(())
    }

    fn require_controller(
        &self,
        caller: &BrowserControllerId,
        lease: &BrowserControllerLease,
    ) -> Result<(), BrowserAdmissionError> {
        self.require_identity(&lease.resource)?;
        self.require_ready()?;
        if caller != &lease.controller_id {
            return Err(BrowserAdmissionError::CallerMismatch);
        }
        if self.controller.as_ref() != Some(lease) {
            return Err(BrowserAdmissionError::ControllerChanged);
        }
        Ok(())
    }

    fn require_command_sequence(&self, sequence: NonZeroU64) -> Result<(), BrowserAdmissionError> {
        if sequence < self.next_command {
            return Err(BrowserAdmissionError::CommandAlreadyDispatched);
        }
        if sequence != self.next_command {
            return Err(BrowserAdmissionError::CommandSequenceGap);
        }
        Ok(())
    }

    fn input_in_flight(&self) -> bool {
        self.active.is_some() || self.dialogs.response_operation().is_some()
    }

    /// Recheck the owned permit at the engine dispatch boundary: a page can
    /// navigate or retire after admission while the adapter awaits readiness.
    /// A pending handoff still allows the already admitted action to drain.
    pub fn dispatch_target(
        &self,
        permit: &BrowserActionPermit,
    ) -> Result<&BrowserTargetId, BrowserAdmissionError> {
        self.require_identity(&permit.resource)?;
        self.require_ready()?;
        let active = self
            .active
            .as_ref()
            .ok_or(BrowserAdmissionError::PermitMismatch)?;
        if active.operation != permit.operation || active.sequence != permit.sequence {
            return Err(BrowserAdmissionError::PermitMismatch);
        }
        for reference in &permit.references {
            self.validate_element(reference)?;
        }
        self.target_for(&permit.page)
    }

    pub fn begin_retirement(
        &mut self,
        resource: &BrowserResourceIdentity,
    ) -> Result<(), BrowserAdmissionError> {
        self.require_identity(resource)?;
        if self.phase.projection() == BrowserResourcePhase::Closed {
            return Err(BrowserAdmissionError::ResourceClosed);
        }
        let revision = advance(self.revision)?;
        self.phase = outcomes::Phase::Retiring;
        self.requested_controller = None;
        self.revision = revision;
        Ok(())
    }

    /// Call only after the adapter observes this exact engine generation exit.
    pub fn engine_exited(
        &mut self,
        resource: &BrowserResourceIdentity,
    ) -> Result<(), BrowserAdmissionError> {
        self.require_identity(resource)?;
        let revision = advance(self.revision)?;
        self.phase = outcomes::Phase::Closed;
        self.active = None;
        self.controller = None;
        self.requested_controller = None;
        self.instances.clear();
        self.pages.clear();
        self.selection = None;
        self.reserved_targets.clear();
        self.network = Default::default();
        self.console = Default::default();
        self.pointer = None;
        self.keyboard = None;
        self.touch = None;
        self.dialogs = Default::default();
        self.revision = revision;
        Ok(())
    }
}

#[cfg(test)]
mod tests;
