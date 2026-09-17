//! A dialog response can drain the input that opened it, under the same lease.

use super::*;
use hmux_session_protocol::browser_dialog::*;

struct Pending {
    opened_at: Instant,
    source: BrowserDialogSourceId,
    dialog: BrowserDialog,
}

pub(super) struct DialogState {
    next: NonZeroU64,
    pending: BTreeMap<BrowserPageId, Pending>,
    response: Option<ActiveAction>,
}

impl Default for DialogState {
    fn default() -> Self {
        Self {
            next: NonZeroU64::MIN,
            pending: BTreeMap::new(),
            response: None,
        }
    }
}

impl DialogState {
    pub(super) fn retire_instance(&mut self, instance: &BrowserInstanceId) {
        if self
            .response
            .as_ref()
            .is_some_and(|response| &response.instance == instance)
        {
            self.response = None;
        }
    }

    pub(super) fn response_operation(&self) -> Option<BrowserOperationId> {
        self.response
            .as_ref()
            .map(|active| active.operation.clone())
    }
    pub(super) fn remove_page(&mut self, page: &BrowserPageId, now: Instant) -> Duration {
        self.pending.remove(page).map_or(Duration::ZERO, |pending| {
            now.saturating_duration_since(pending.opened_at)
        })
    }
}

/// An ephemeral projection of the Host's page/dialog lifecycle.
pub struct BrowserExecutionTime {
    pub elapsed: Duration,
    pub suspended: bool,
}

/// An exact, uncloneable response permit. Adapters cannot mint or retarget it.
pub struct BrowserDialogPermit {
    dialog: BrowserDialogIdentity,
    source: BrowserDialogSourceId,
    operation: BrowserOperationId,
    sequence: NonZeroU64,
    response: BrowserDialogResponse,
}

impl BrowserDialogPermit {
    pub fn response(&self) -> &BrowserDialogResponse {
        &self.response
    }
}

fn bounded(text: &str, truncated: &mut bool) -> String {
    let mut end = text.len().min(MAX_DIALOG_TEXT_BYTES);
    *truncated |= end != text.len();
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_owned()
}

impl BrowserResourceHost {
    pub fn dialog_opened(
        &mut self,
        page: &BrowserPageIdentity,
        source: BrowserDialogSourceId,
        kind: BrowserDialogKind,
        text: (&str, &str, &str),
        observed_at: Instant,
    ) -> Result<(), BrowserAdmissionError> {
        self.require_ready()?;
        self.target_for(page)?;
        self.require_dialog_observation(&page.page_id)?;
        // An opening without the previous close is an incomplete observation,
        // not permission to overwrite a dialog that a caller may be answering.
        if self.dialogs.pending.contains_key(&page.page_id) {
            return Err(BrowserAdmissionError::DialogChanged);
        }
        let next = advance(self.dialogs.next)?;
        let revision = advance(self.revision)?;
        let mut truncated = false;
        let dialog = BrowserDialog {
            identity: BrowserDialogIdentity {
                page: page.clone(),
                revision: self.dialogs.next,
            },
            kind,
            message: bounded(text.0, &mut truncated),
            url: bounded(text.1, &mut truncated),
            default_prompt: bounded(text.2, &mut truncated),
            truncated,
        };
        self.dialogs.pending.insert(
            page.page_id.clone(),
            Pending {
                source,
                dialog,
                opened_at: observed_at,
            },
        );
        self.dialogs.next = next;
        self.revision = revision;
        Ok(())
    }

    pub fn dialog_closed(
        &mut self,
        source: &BrowserDialogSourceId,
        observed_at: Instant,
    ) -> Result<(), BrowserAdmissionError> {
        if self
            .dialogs
            .pending
            .values()
            .any(|pending| &pending.source == source)
        {
            let revision = advance(self.revision)?;
            let pages = &mut self.pages;
            self.dialogs.pending.retain(|page_id, pending| {
                if &pending.source != source {
                    return true;
                }
                if let Some(page) = pages.get_mut(page_id) {
                    page.dialog_wait += observed_at.saturating_duration_since(pending.opened_at);
                }
                false
            });
            self.revision = revision;
        }
        Ok(())
    }

    pub fn dialog_observation_lost(&mut self, instance: &BrowserInstanceId) {
        let pages = self
            .pages
            .iter()
            .filter(|(_, page)| &page.instance == instance)
            .map(|(id, _)| id.clone())
            .collect();
        self.lose_dialog_observation(&pages);
    }

    fn lose_dialog_observation(&mut self, pages: &BTreeSet<BrowserPageId>) {
        for (id, page) in &mut self.pages {
            if pages.contains(id) {
                page.dialog_observation_lost = true;
            }
        }
        let owners = pages
            .iter()
            .filter(|id| {
                self.dialogs.pending.contains_key(*id)
                    || self
                        .dialogs
                        .response
                        .as_ref()
                        .is_some_and(|response| response.page.as_ref() == Some(*id))
            })
            .filter_map(|id| self.pages.get(id).map(|page| page.instance.clone()))
            .collect::<Vec<_>>();
        if let Some(Ok(revision)) = self.outcome_unknown(owners).then(|| advance(self.revision)) {
            self.revision = revision;
        }
    }

    pub fn dialog_source_detached(&mut self, source: &BrowserDialogSourceId) {
        let pages = self
            .dialogs
            .pending
            .iter()
            .filter(|(_, pending)| &pending.source == source)
            .map(|(id, _)| id.clone())
            .collect();
        self.lose_dialog_observation(&pages);
    }

    fn require_dialog_observation(
        &self,
        page: &BrowserPageId,
    ) -> Result<(), BrowserAdmissionError> {
        if self
            .pages
            .get(page)
            .ok_or(BrowserAdmissionError::PageGone)?
            .dialog_observation_lost
        {
            return Err(BrowserAdmissionError::DialogObservationLost);
        }
        Ok(())
    }

    pub fn dialog_observation(
        &self,
        page: &BrowserPageId,
    ) -> Result<BrowserDialogObservation, BrowserAdmissionError> {
        self.require_dialog_observation(page)?;
        Ok(BrowserDialogObservation {
            control: self.projection(),
            page: self.page_identity(page)?,
            dialog: self
                .dialogs
                .pending
                .get(page)
                .map(|pending| pending.dialog.clone()),
        })
    }

    /// Renderer execution time excludes only this page's observed dialog wait.
    /// A document change retains the page clock; known input releases may finish
    /// after navigation. Page loss or unknown observation never grants more time.
    pub fn execution_time(
        &self,
        target: &BrowserTargetId,
        now: Instant,
    ) -> Result<BrowserExecutionTime, BrowserAdmissionError> {
        self.require_ready()?;
        let (id, page) = self
            .pages
            .iter()
            .find(|(_, page)| &page.target == target)
            .ok_or(BrowserAdmissionError::PageGone)?;
        self.require_active_instance(&page.instance)?;
        self.require_dialog_observation(id)?;
        let pending = self.dialogs.pending.get(id);
        let waiting = page.dialog_wait
            + pending.map_or(Duration::ZERO, |dialog| {
                now.saturating_duration_since(dialog.opened_at)
            });
        let elapsed = now
            .saturating_duration_since(page.execution_started)
            .checked_sub(waiting)
            .ok_or(BrowserAdmissionError::DialogObservationLost)?;
        Ok(BrowserExecutionTime {
            elapsed,
            suspended: pending.is_some(),
        })
    }

    pub fn begin_dialog_response(
        &mut self,
        caller: &BrowserControllerId,
        authority: &BrowserActionAuthority,
        dialog: &BrowserDialogIdentity,
        response: BrowserDialogResponse,
    ) -> Result<BrowserDialogPermit, BrowserAdmissionError> {
        self.require_controller(caller, &authority.lease)?;
        self.require_dialog_observation(&authority.page.page_id)?;
        self.require_command_sequence(authority.command_sequence)?;
        self.target_for(&authority.page)?;
        if authority.page != dialog.page {
            return Err(BrowserAdmissionError::DialogChanged);
        }
        let pending = self
            .dialogs
            .pending
            .get(&dialog.page.page_id)
            .filter(|pending| pending.dialog.identity == *dialog)
            .ok_or(BrowserAdmissionError::DialogChanged)?;
        if self.dialogs.response.is_some() {
            return Err(BrowserAdmissionError::ActionInFlight);
        }
        if matches!(response, BrowserDialogResponse::Accept { text: Some(_) })
            && pending.dialog.kind != BrowserDialogKind::Prompt
        {
            return Err(BrowserAdmissionError::DialogResponseInvalid);
        }
        let next = advance(self.next_command)?;
        let revision = advance(self.revision)?;
        let permit = BrowserDialogPermit {
            dialog: dialog.clone(),
            source: pending.source.clone(),
            operation: authority.operation_id.clone(),
            sequence: authority.command_sequence,
            response,
        };
        self.dialogs.response = Some(ActiveAction {
            operation: authority.operation_id.clone(),
            sequence: authority.command_sequence,
            page: Some(dialog.page.page_id.clone()),
            instance: self.instance_for_page(&dialog.page.page_id)?.clone(),
            page_creation: None,
            creation_label: None,
        });
        self.next_command = next;
        self.revision = revision;
        Ok(permit)
    }

    fn require_dialog_permit(
        &self,
        permit: &BrowserDialogPermit,
    ) -> Result<(), BrowserAdmissionError> {
        self.require_identity(&permit.dialog.page.resource)?;
        if !self.dialogs.response.as_ref().is_some_and(|active| {
            active.operation == permit.operation && active.sequence == permit.sequence
        }) {
            return Err(BrowserAdmissionError::PermitMismatch);
        }
        Ok(())
    }

    pub fn dispatch_dialog<'a>(
        &self,
        permit: &'a BrowserDialogPermit,
    ) -> Result<&'a BrowserDialogSourceId, BrowserAdmissionError> {
        self.require_dialog_permit(permit)?;
        self.require_ready()?;
        self.require_dialog_observation(&permit.dialog.page.page_id)?;
        self.target_for(&permit.dialog.page)?;
        if !self
            .dialogs
            .pending
            .get(&permit.dialog.page.page_id)
            .is_some_and(|pending| {
                pending.dialog.identity == permit.dialog && pending.source == permit.source
            })
        {
            return Err(BrowserAdmissionError::DialogChanged);
        }
        Ok(&permit.source)
    }

    pub fn finish_dialog_response(
        &mut self,
        permit: BrowserDialogPermit,
        outcome: BrowserActionOutcome,
    ) -> Result<BrowserControlProjection, BrowserAdmissionError> {
        self.require_dialog_permit(&permit)?;
        let revision = advance(self.revision)?;
        if outcome == BrowserActionOutcome::OutcomeUnknown {
            let instance = self.dialogs.response.as_ref().unwrap().instance.clone();
            self.outcome_unknown([instance]);
        } else {
            // Only the ordered close event retires a dialog. A successful reply
            // may already have opened a different prompt on this same page.
            self.dialogs.response = None;
        }
        self.revision = revision;
        self.grant_drained_input_transfer()?;
        Ok(self.projection())
    }
}

#[cfg(test)]
mod tests;
