//! Frame selection belongs to the page's existing serialized input authority.

use super::*;

struct Frame {
    parent: Option<BrowserFrameId>,
    document: BrowserDocumentId,
    revision: NonZeroU64,
}

pub(super) struct Frames {
    live: BTreeMap<BrowserFrameId, Frame>,
    selected: Option<(BrowserFrameId, bool)>,
    next_document: NonZeroU64,
    pub(super) revision: NonZeroU64,
}

impl Default for Frames {
    fn default() -> Self {
        Self {
            live: BTreeMap::new(),
            selected: None,
            next_document: NonZeroU64::MIN,
            revision: NonZeroU64::MIN,
        }
    }
}

impl Frames {
    fn descendants(&self, id: &BrowserFrameId) -> BTreeSet<BrowserFrameId> {
        let mut removed = BTreeSet::from([id.clone()]);
        loop {
            let before = removed.len();
            for (id, frame) in &self.live {
                if frame
                    .parent
                    .as_ref()
                    .is_some_and(|parent| removed.contains(parent))
                {
                    removed.insert(id.clone());
                }
            }
            if before == removed.len() {
                return removed;
            }
        }
    }
}

impl BrowserResourceHost {
    /// Only the retained, page-owned native event source may report documents.
    /// An out-of-process frame remains a descendant of this page, never a tab.
    pub fn frame_document_observed(
        &mut self,
        page: &BrowserPageIdentity,
        id: BrowserFrameId,
        parent: Option<BrowserFrameId>,
        document: BrowserDocumentId,
    ) -> Result<(), BrowserAdmissionError> {
        self.target_for(page)?;
        let current = self.pages.get_mut(&page.page_id).expect("validated page");
        let frames = &mut current.frames;
        if frames
            .live
            .get(&id)
            .is_some_and(|frame| frame.document == document && frame.parent == parent)
        {
            return Ok(());
        }
        if !frames.live.contains_key(&id) && frames.live.len() >= 1024 {
            return Err(BrowserAdmissionError::CapacityExceeded);
        }
        let removed = frames.descendants(&id);
        if parent
            .as_ref()
            .is_some_and(|parent| removed.contains(parent))
        {
            return Err(BrowserAdmissionError::FrameChanged);
        }
        let selected_changed = frames
            .selected
            .as_ref()
            .is_some_and(|(selected, _)| removed.contains(selected));
        let next_document = advance(frames.next_document)?;
        let revision = advance(self.revision)?;
        let scope_revision = if selected_changed {
            advance(frames.revision)?
        } else {
            frames.revision
        };
        frames.live.retain(|child, _| !removed.contains(child));
        if let Some((selected, live)) = &mut frames.selected {
            if selected != &id && removed.contains(selected) {
                *live = false;
            }
        }
        frames.live.insert(
            id,
            Frame {
                parent,
                document,
                revision: frames.next_document,
            },
        );
        frames.next_document = next_document;
        frames.revision = scope_revision;
        if selected_changed {
            current.snapshot_revision = None;
            current.elements.clear();
        }
        self.revision = revision;
        Ok(())
    }

    pub fn frame_removed(
        &mut self,
        page: &BrowserPageIdentity,
        id: &BrowserFrameId,
    ) -> Result<(), BrowserAdmissionError> {
        self.target_for(page)?;
        let current = self.pages.get_mut(&page.page_id).expect("validated page");
        let removed = current.frames.descendants(id);
        let selected_changed = current
            .frames
            .selected
            .as_ref()
            .is_some_and(|(selected, _)| removed.contains(selected));
        let revision = advance(self.revision)?;
        if selected_changed {
            let frame_revision = advance(current.frames.revision)?;
            if let Some((_, live)) = &mut current.frames.selected {
                *live = false;
            }
            current.frames.revision = frame_revision;
            current.snapshot_revision = None;
            current.elements.clear();
        }
        current.frames.live.retain(|id, _| !removed.contains(id));
        // Retain a missing selection. Its next operation must not silently
        // target the main document or a replacement iframe at the same selector.
        self.revision = revision;
        Ok(())
    }

    pub fn frame_identity(
        &self,
        page: &BrowserPageIdentity,
        id: &BrowserFrameId,
    ) -> Result<BrowserFrameIdentity, BrowserAdmissionError> {
        self.target_for(page)?;
        let frame = self.pages[&page.page_id]
            .frames
            .live
            .get(id)
            .ok_or(BrowserAdmissionError::FrameGone)?;
        Ok(BrowserFrameIdentity {
            page: page.clone(),
            frame_id: id.clone(),
            document_revision: frame.revision,
        })
    }

    pub fn selected_frame(
        &self,
        page: &BrowserPageIdentity,
    ) -> Result<Option<BrowserFrameIdentity>, BrowserAdmissionError> {
        self.target_for(page)?;
        self.pages[&page.page_id]
            .frames
            .selected
            .as_ref()
            .map(|(id, live)| {
                if !live {
                    return Err(BrowserAdmissionError::FrameGone);
                }
                self.frame_identity(page, id)
            })
            .transpose()
    }

    pub fn validate_frame(
        &self,
        frame: &BrowserFrameIdentity,
    ) -> Result<(), BrowserAdmissionError> {
        if self.frame_identity(&frame.page, &frame.frame_id)? != *frame {
            return Err(BrowserAdmissionError::FrameChanged);
        }
        Ok(())
    }

    pub fn select_frame(
        &mut self,
        permit: &BrowserActionPermit,
        frame: Option<&BrowserFrameIdentity>,
    ) -> Result<(), BrowserAdmissionError> {
        self.dispatch_target(permit)?;
        if let Some(frame) = frame {
            if frame.page != permit.page {
                return Err(BrowserAdmissionError::PageGone);
            }
            self.validate_frame(frame)?;
        }
        let selected = frame.map(|frame| (frame.frame_id.clone(), true));
        if self.pages[&permit.page.page_id].frames.selected == selected {
            return Ok(());
        }
        let revision = advance(self.revision)?;
        let page = self
            .pages
            .get_mut(&permit.page.page_id)
            .expect("validated page");
        page.frames.revision = advance(page.frames.revision)?;
        page.frames.selected = selected;
        page.snapshot_revision = None;
        page.elements.clear();
        self.revision = revision;
        Ok(())
    }

    /// Document-scoped dispatch also fences navigation/removal after admission.
    /// Page-level recovery (including explicit main-frame reset) uses the same
    /// permit's page fence and remains possible after a selected frame disappears.
    pub fn dispatch_frame(
        &self,
        permit: &BrowserActionPermit,
    ) -> Result<Option<BrowserFrameIdentity>, BrowserAdmissionError> {
        self.dispatch_target(permit)?;
        if self.pages[&permit.page.page_id].frames.revision != permit.frame_revision {
            return Err(BrowserAdmissionError::FrameChanged);
        }
        self.selected_frame(&permit.page)
    }

    /// Return the selected document and each embedding document, ending at
    /// this page's main frame. Missing ancestry cannot authorize coordinates.
    pub fn frame_ancestry(
        &self,
        frame: &BrowserFrameIdentity,
    ) -> Result<Vec<BrowserFrameIdentity>, BrowserAdmissionError> {
        self.validate_frame(frame)?;
        let mut result = Vec::new();
        let mut next = Some(frame.frame_id.clone());
        while let Some(id) = next {
            if result.len() >= 1024 {
                return Err(BrowserAdmissionError::CapacityExceeded);
            }
            result.push(self.frame_identity(&frame.page, &id)?);
            next = self.pages[&frame.page.page_id].frames.live[&id]
                .parent
                .clone();
        }
        Ok(result)
    }

    pub fn snapshot_observed_in_frame(
        &mut self,
        page: &BrowserPageIdentity,
        frame: &Option<BrowserFrameIdentity>,
        elements: BTreeSet<BrowserElementId>,
    ) -> Result<BrowserSnapshotIdentity, BrowserAdmissionError> {
        if self.selected_frame(page)? != *frame {
            return Err(BrowserAdmissionError::FrameChanged);
        }
        self.snapshot_observed(page, elements)
    }
}
