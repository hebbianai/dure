use super::*;
use hmux_session_protocol::browser_recording::BrowserRecordingStatus;

pub(super) struct RecordingState {
    operation: BrowserOperationId,
    finished: bool,
}

/// Capture may observe this page across documents and controllers, until its
/// recorded interval or native binding retires. This grants no page input.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BrowserRecordingLease {
    resource: BrowserResourceIdentity,
    page: BrowserPageId,
    target: BrowserTargetId,
    operation: BrowserOperationId,
}

/// One admitted native transition. Clients cannot mint its completion authority.
pub struct BrowserRecordingPermit {
    resource: BrowserResourceIdentity,
    page: BrowserPageId,
    target: BrowserTargetId,
    operation: BrowserOperationId,
    sequence: NonZeroU64,
    recording: BrowserOperationId,
    starting: bool,
}

impl BrowserRecordingPermit {
    pub fn target(&self) -> &BrowserTargetId {
        &self.target
    }

    pub fn recording(&self) -> &BrowserOperationId {
        &self.recording
    }
}

impl BrowserResourceHost {
    pub fn recording_status(
        &self,
        resource: &BrowserResourceIdentity,
        page: &BrowserPageId,
    ) -> Result<BrowserRecordingStatus, BrowserAdmissionError> {
        self.require_identity(resource)?;
        Ok(BrowserRecordingStatus {
            page: self.page_identity(page)?,
            phase: self.phase.projection(),
            operation_id: self.pages[page]
                .recording
                .as_ref()
                .map(|state| state.operation.clone()),
            finished: self.pages[page]
                .recording
                .as_ref()
                .is_some_and(|state| state.finished),
        })
    }

    pub fn prepare_recording(
        &self,
        permit: &BrowserActionPermit,
        starting: bool,
    ) -> Result<BrowserRecordingPermit, BrowserAdmissionError> {
        let target = self.dispatch_target(permit)?.clone();
        let recording = &self.pages[&permit.page.page_id].recording;
        let recording = match (starting, recording) {
            (true, None) => permit.operation.clone(),
            (false, Some(recording)) => recording.operation.clone(),
            (true, Some(_)) => return Err(BrowserAdmissionError::RecordingAlreadyActive),
            (false, None) => return Err(BrowserAdmissionError::RecordingNotActive),
        };
        Ok(BrowserRecordingPermit {
            resource: self.identity.clone(),
            page: permit.page.page_id.clone(),
            target,
            operation: permit.operation.clone(),
            sequence: permit.sequence,
            recording,
            starting,
        })
    }

    /// A native acknowledgement may arrive after navigation. It belongs to the
    /// same admitted page transition, regardless of its current document/owner.
    pub fn recording_acknowledged(
        &mut self,
        permit: BrowserRecordingPermit,
    ) -> Result<Option<BrowserRecordingLease>, BrowserAdmissionError> {
        self.require_identity(&permit.resource)?;
        self.require_ready()?;
        let active = self
            .active
            .as_ref()
            .ok_or(BrowserAdmissionError::PermitMismatch)?;
        if active.operation != permit.operation || active.sequence != permit.sequence {
            return Err(BrowserAdmissionError::PermitMismatch);
        }
        let page = self
            .pages
            .get(&permit.page)
            .ok_or(BrowserAdmissionError::PageGone)?;
        if page.target != permit.target
            || (if permit.starting {
                page.recording.is_some()
            } else {
                page.recording.as_ref().map(|state| &state.operation) != Some(&permit.recording)
            })
        {
            return Err(BrowserAdmissionError::PermitMismatch);
        }
        let revision = advance(self.revision)?;
        let lease = permit.starting.then(|| BrowserRecordingLease {
            resource: permit.resource.clone(),
            page: permit.page.clone(),
            target: permit.target.clone(),
            operation: permit.recording.clone(),
        });
        self.pages.get_mut(&permit.page).unwrap().recording =
            permit.starting.then_some(RecordingState {
                operation: permit.recording,
                finished: false,
            });
        self.revision = revision;
        Ok(lease)
    }

    pub fn recording_target(
        &self,
        lease: &BrowserRecordingLease,
    ) -> Result<&BrowserTargetId, BrowserAdmissionError> {
        self.require_ready()?;
        let page = self.recording_page(lease)?;
        if page.recording.as_ref().unwrap().finished {
            return Err(BrowserAdmissionError::RecordingNotActive);
        }
        self.require_active_instance(&page.instance)?;
        Ok(&page.target)
    }

    /// The exact native owner reports finish even if the stop caller vanished.
    /// A missing native acknowledgement fences the resource's effect owner.
    pub fn recording_finished(
        &mut self,
        lease: &BrowserRecordingLease,
        acknowledged: bool,
    ) -> Result<(), BrowserAdmissionError> {
        let instance = self.recording_page(lease)?.instance.clone();
        let revision = advance(self.revision)?;
        self.pages
            .get_mut(&lease.page)
            .unwrap()
            .recording
            .as_mut()
            .unwrap()
            .finished = acknowledged;
        if !acknowledged {
            self.outcome_unknown([instance]);
        }
        self.revision = revision;
        Ok(())
    }

    fn recording_page(
        &self,
        lease: &BrowserRecordingLease,
    ) -> Result<&PageState, BrowserAdmissionError> {
        self.require_identity(&lease.resource)?;
        let page = self
            .pages
            .get(&lease.page)
            .ok_or(BrowserAdmissionError::PageGone)?;
        if page.target != lease.target
            || page.recording.as_ref().map(|state| &state.operation) != Some(&lease.operation)
        {
            return Err(BrowserAdmissionError::RecordingNotActive);
        }
        Ok(page)
    }
}
