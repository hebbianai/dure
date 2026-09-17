use terminal_state_protocol::{
    BufferId, DecodedRecord, StateSnapshot, TerminalStateRecord, ViewportAnchorStatus,
    ViewportFrame, ViewportIngressAuthority, ViewportIntent, terminal_state_record,
    validate_viewport_ingress, viewport_intent,
};

use super::cold_history::LogicalCellAnchor;
use super::composite_viewport_source::CompositeViewportSource;
use super::viewport_source::{
    BoundedViewportRows, TerminalViewportAnchor, TerminalViewportMetrics, ViewportAnchorError,
    ViewportProjectionGeometry, ViewportSource,
};
use super::{TerminalReplay, TerminalReplayError};
use crate::local_protocol::SessionFence;
use std::sync::Arc;

/// Ephemeral presentation state for one attached structured surface.
///
/// The runtime stores this value beside the attachment's geometry proposal.
/// It is never checkpointed or restored; a fresh attachment starts at tail.
pub struct ViewProjection {
    origin_fence: SessionFence,
    source_owner: u64,
    projection_id: u64,
    attached: bool,
    viewport_rows: Option<u16>,
    follow_tail: bool,
    anchor_status: ViewportAnchorStatus,
    rows_from_tail: Option<u64>,
    anchor: Option<Box<dyn TerminalViewportAnchor>>,
    anchor_logical: Option<LogicalCellAnchor>,
    anchor_buffer: Option<i32>,
    pending_scroll_rows: i64,
    projection_revision: u64,
    projected_terminal_revision: u64,
    projected_through_output_seq: u64,
    pending_local_change: bool,
    last_record_id: Option<u64>,
    applied_intent_seq: u64,
    last_intent: Option<ViewportIntent>,
    last_wheel_route: Option<WheelIntentRoute>,
    #[cfg(test)]
    last_projection_work: Option<(usize, super::viewport_source::ViewportProjectionWork)>,
}

/// Scalar viewport state needed to capture one immutable hot-row generation.
///
/// The request contains no native anchor. Ghostty resolves the stable logical
/// anchor while the terminal actor is available, then copies only the row
/// windows needed by this attachment.
#[derive(Clone)]
pub struct ViewportCaptureRequest {
    pub(super) origin_fence: SessionFence,
    pub(super) source_owner: u64,
    pub(super) viewport_rows: u16,
    pub(super) follow_tail: bool,
    pub(super) anchor_logical: Option<LogicalCellAnchor>,
    pub(super) anchor_buffer: Option<i32>,
    pub(super) pending_scroll_rows: i64,
}

#[cfg(test)]
impl ViewportCaptureRequest {
    pub(super) fn tail_for_test(viewport_rows: u16) -> Self {
        Self {
            origin_fence: SessionFence {
                workspace_id: "test".into(),
                session_id: "test".into(),
                runner_principal: "test".into(),
                runner_instance: "test".into(),
                channel_epoch: 1,
                host_instance_id: "test".into(),
                terminal_epoch: "test".into(),
            },
            source_owner: 0,
            viewport_rows,
            follow_tail: true,
            anchor_logical: None,
            anchor_buffer: None,
            pending_scroll_rows: 0,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ViewportIntentDisposition {
    Applied,
    Duplicate,
    NoChange,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WheelPtySink {
    Connected,
    Absent,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WheelIntentRoute {
    Pty,
    Viewport,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ViewportIntentApplication {
    pub disposition: ViewportIntentDisposition,
    pub wheel_route: Option<WheelIntentRoute>,
    pub pty_bytes: Vec<u8>,
}

impl ViewProjection {
    fn new(
        origin_fence: SessionFence,
        source_owner: u64,
        projection_id: u64,
        viewport_rows: u16,
    ) -> Self {
        Self {
            origin_fence,
            source_owner,
            projection_id,
            attached: true,
            viewport_rows: Some(viewport_rows),
            follow_tail: true,
            anchor_status: ViewportAnchorStatus::FollowTail,
            rows_from_tail: Some(0),
            anchor: None,
            anchor_logical: None,
            anchor_buffer: None,
            pending_scroll_rows: 0,
            projection_revision: 0,
            projected_terminal_revision: 0,
            projected_through_output_seq: 0,
            pending_local_change: true,
            last_record_id: None,
            applied_intent_seq: 0,
            last_intent: None,
            last_wheel_route: None,
            #[cfg(test)]
            last_projection_work: None,
        }
    }

    #[must_use]
    pub fn projection_id(&self) -> u64 {
        self.projection_id
    }

    #[must_use]
    pub fn terminal_epoch(&self) -> &str {
        &self.origin_fence.terminal_epoch
    }

    #[must_use]
    pub fn capture_request(&self) -> Option<ViewportCaptureRequest> {
        self.attached.then_some(ViewportCaptureRequest {
            origin_fence: self.origin_fence.clone(),
            source_owner: self.source_owner,
            viewport_rows: self.viewport_rows?,
            follow_tail: self.follow_tail,
            anchor_logical: self.anchor_logical,
            anchor_buffer: self.anchor_buffer,
            pending_scroll_rows: self.pending_scroll_rows,
        })
    }

    /// Copy only attachment-owned scalar state for an actor-free projection.
    /// Native/source anchors are generation-local and are rebound from the
    /// stable logical anchor by `CapturedViewportSource`.
    #[must_use]
    pub fn fork_for_projection(&self) -> Self {
        Self {
            origin_fence: self.origin_fence.clone(),
            source_owner: self.source_owner,
            projection_id: self.projection_id,
            attached: self.attached,
            viewport_rows: self.viewport_rows,
            follow_tail: self.follow_tail,
            anchor_status: self.anchor_status,
            rows_from_tail: self.rows_from_tail,
            anchor: None,
            anchor_logical: self.anchor_logical,
            anchor_buffer: self.anchor_buffer,
            pending_scroll_rows: self.pending_scroll_rows,
            projection_revision: self.projection_revision,
            projected_terminal_revision: self.projected_terminal_revision,
            projected_through_output_seq: self.projected_through_output_seq,
            pending_local_change: self.pending_local_change,
            last_record_id: self.last_record_id,
            applied_intent_seq: self.applied_intent_seq,
            last_intent: self.last_intent,
            last_wheel_route: self.last_wheel_route,
            #[cfg(test)]
            last_projection_work: self.last_projection_work,
        }
    }

    /// Commit one detached projection only if its scalar base is still current.
    ///
    /// A newer worker may commit while this projection is off-actor. Returning
    /// `false` lets the scheduler discard and recapture that superseded work
    /// instead of moving the attachment's projection high-water backward.
    pub fn commit_projected(&mut self, projected: Self) -> Result<bool, TerminalReplayError> {
        if self.origin_fence != projected.origin_fence
            || self.source_owner != projected.source_owner
            || self.projection_id != projected.projection_id
        {
            return Err(TerminalReplayError::InvalidStructuredProjection {
                reason: "committed projection identity does not match its origin",
            });
        }
        if !projected.attached {
            return Err(TerminalReplayError::InvalidStructuredProjection {
                reason: "committed projection was detached before it could commit",
            });
        }
        if projected.projection_revision
            != self
                .projection_revision
                .checked_add(1)
                .ok_or(TerminalReplayError::TerminalStateRevisionExhausted)?
        {
            return Ok(false);
        }
        *self = projected;
        Ok(true)
    }

    #[cfg(test)]
    fn is_attached(&self) -> bool {
        self.attached
    }

    fn active_buffer(metrics: TerminalViewportMetrics) -> i32 {
        if metrics.alternate_screen {
            BufferId::Alternate as i32
        } else {
            BufferId::Normal as i32
        }
    }

    fn reset_if_buffer_changed(&mut self, metrics: TerminalViewportMetrics) {
        if self.anchor_buffer != Some(Self::active_buffer(metrics)) {
            self.follow_tail = true;
            self.anchor_status = ViewportAnchorStatus::FollowTail;
            self.rows_from_tail = Some(0);
            self.anchor = None;
            self.anchor_logical = None;
            self.anchor_buffer = None;
        }
    }

    fn set_viewport_rows(&mut self, viewport_rows: u16) -> bool {
        if self.viewport_rows == Some(viewport_rows) {
            return false;
        }
        self.viewport_rows = Some(viewport_rows);
        if self.follow_tail {
            self.anchor_status = ViewportAnchorStatus::FollowTail;
            self.rows_from_tail = Some(0);
        } else {
            self.anchor_status = ViewportAnchorStatus::Anchored;
            self.rows_from_tail = None;
        }
        self.pending_local_change = true;
        true
    }

    #[cfg(test)]
    fn projection_work(&self) -> (usize, super::viewport_source::ViewportProjectionWork) {
        self.last_projection_work
            .expect("a projected frame records bounded source work")
    }
}

#[derive(Clone)]
struct CachedViewportSource {
    terminal_revision: u64,
    snapshot: Arc<StateSnapshot>,
    metrics: TerminalViewportMetrics,
}

/// One immutable, bounded canonical terminal generation.
///
/// The terminal actor creates this once while it owns Ghostty. Attachment
/// workers clone the handle and perform hot/cold range projection without
/// retaining or reacquiring the terminal actor lock.
#[derive(Clone)]
pub struct CapturedViewportSource {
    origin_fence: SessionFence,
    source_owner: u64,
    through_output_seq: u64,
    state_revision: u64,
    source: CachedViewportSource,
    composite: Arc<CompositeViewportSource>,
    accounted_capture_bytes: usize,
}

impl CapturedViewportSource {
    #[must_use]
    pub fn terminal_revision(&self) -> u64 {
        self.source.terminal_revision
    }

    #[must_use]
    pub fn accounted_capture_bytes(&self) -> usize {
        self.accounted_capture_bytes
    }

    pub fn capture_latest_viewport_frame(
        &self,
        projection: &mut ViewProjection,
    ) -> Result<Option<CapturedViewportFrame>, TerminalReplayError> {
        if !projection.attached
            || projection.projection_id == 0
            || projection.source_owner != self.source_owner
            || projection.origin_fence != self.origin_fence
        {
            return Err(TerminalReplayError::InvalidStructuredProjection {
                reason: "capture projection is detached or belongs to another source",
            });
        }
        let Some(viewport_rows) = projection.viewport_rows else {
            return Ok(None);
        };
        if !projection.pending_local_change
            && projection.projected_terminal_revision == self.source.terminal_revision
            && projection.projected_through_output_seq == self.through_output_seq
        {
            return Ok(None);
        }
        if projection.projected_terminal_revision != self.source.terminal_revision {
            if projection.follow_tail {
                if !projection.pending_local_change {
                    projection.anchor_status = ViewportAnchorStatus::FollowTail;
                }
                projection.rows_from_tail = Some(0);
            } else {
                projection.rows_from_tail = None;
            }
        }

        projection.reset_if_buffer_changed(self.source.metrics);
        let geometry = viewport_geometry(&self.source, viewport_rows)?;
        self.apply_pending_scroll(projection, &geometry)?;
        if !projection.follow_tail {
            if let Some(anchor) = projection.anchor_logical {
                projection.anchor = Some(
                    self.composite
                        .resolve_logical_anchor(anchor, &geometry)
                        .map_err(ViewportAnchorError::into_terminal_error)?,
                );
            }
        }
        let projected = if projection.follow_tail {
            self.composite
                .track_tail_viewport_anchor(&geometry)?
                .project_rows(&geometry)
        } else {
            projection
                .anchor
                .as_ref()
                .ok_or(TerminalReplayError::InvalidStructuredProjection {
                    reason: "parked viewport has no anchor",
                })?
                .project_rows(&geometry)
        };
        let mut viewport = match projected {
            Ok(viewport) => viewport,
            Err(ViewportAnchorError::Pruned) => {
                projection.follow_tail = true;
                projection.anchor_status = ViewportAnchorStatus::PrunedToTail;
                projection.rows_from_tail = Some(0);
                projection.anchor = None;
                projection.anchor_logical = None;
                projection.anchor_buffer = None;
                self.composite
                    .track_tail_viewport_anchor(&geometry)?
                    .project_rows(&geometry)
                    .map_err(ViewportAnchorError::into_terminal_error)?
            }
            Err(error) => return Err(error.into_terminal_error()),
        };
        if !projection.follow_tail && !viewport.has_more_after {
            projection.follow_tail = true;
            projection.anchor_status = ViewportAnchorStatus::ClampedTail;
            projection.rows_from_tail = Some(0);
            projection.anchor = None;
            projection.anchor_logical = None;
            projection.anchor_buffer = None;
            viewport = self
                .composite
                .track_tail_viewport_anchor(&geometry)?
                .project_rows(&geometry)
                .map_err(ViewportAnchorError::into_terminal_error)?;
        } else if !projection.follow_tail {
            projection.anchor_logical = viewport.rows.first().map(row_logical_anchor);
            if !viewport.has_more_before {
                projection.anchor_status = ViewportAnchorStatus::ClampedStart;
            }
        }
        let projection_revision = projection
            .projection_revision
            .checked_add(1)
            .ok_or(TerminalReplayError::TerminalStateRevisionExhausted)?;
        #[cfg(test)]
        let projection_work = (viewport.visited_rows, viewport.work);
        projection.projection_revision = projection_revision;
        projection.projected_terminal_revision = self.source.terminal_revision;
        projection.projected_through_output_seq = self.through_output_seq;
        projection.pending_local_change = false;
        #[cfg(test)]
        {
            projection.last_projection_work = Some(projection_work);
        }
        Ok(Some(CapturedViewportFrame {
            terminal_epoch: self.origin_fence.terminal_epoch.clone(),
            through_output_seq: self.through_output_seq,
            state_revision: self.state_revision,
            projection_revision,
            geometry,
            source: self.source.clone(),
            follow_tail: projection.follow_tail,
            applied_intent_seq: projection.applied_intent_seq,
            anchor_status: projection.anchor_status,
            rows_from_tail: projection.rows_from_tail,
            viewport,
        }))
    }

    fn apply_pending_scroll(
        &self,
        projection: &mut ViewProjection,
        geometry: &ViewportProjectionGeometry,
    ) -> Result<(), TerminalReplayError> {
        let rows = std::mem::take(&mut projection.pending_scroll_rows);
        if rows == 0 {
            return Ok(());
        }
        if projection.follow_tail {
            projection.anchor = Some(self.composite.track_tail_viewport_anchor(geometry)?);
            projection.anchor_logical = None;
            projection.anchor_buffer = Some(ViewProjection::active_buffer(self.source.metrics));
        } else if let Some(anchor) = projection.anchor_logical {
            projection.anchor = Some(
                self.composite
                    .resolve_logical_anchor(anchor, geometry)
                    .map_err(ViewportAnchorError::into_terminal_error)?,
            );
        }
        let delta = rows.saturating_neg();
        let moved = projection
            .anchor
            .as_mut()
            .ok_or(TerminalReplayError::InvalidStructuredProjection {
                reason: "scrolled viewport has no anchor to move",
            })?
            .move_rows(delta, geometry)
            .map_err(ViewportAnchorError::into_terminal_error)?;
        let projected = projection
            .anchor
            .as_ref()
            .ok_or(TerminalReplayError::InvalidStructuredProjection {
                reason: "scrolled viewport lost its anchor",
            })?
            .project_rows(geometry)
            .map_err(ViewportAnchorError::into_terminal_error)?;
        let reached_tail = rows < 0 && !projected.has_more_after;
        if reached_tail {
            projection.follow_tail = true;
            projection.anchor_status = ViewportAnchorStatus::ClampedTail;
            projection.rows_from_tail = Some(0);
            projection.anchor = None;
            projection.anchor_logical = None;
            projection.anchor_buffer = None;
            return Ok(());
        }

        projection.follow_tail = false;
        projection.anchor_buffer = Some(ViewProjection::active_buffer(self.source.metrics));
        projection.anchor_status = if delta < 0 && !projected.has_more_before {
            ViewportAnchorStatus::ClampedStart
        } else {
            ViewportAnchorStatus::Anchored
        };
        projection.anchor_logical = projected.rows.first().map(row_logical_anchor);
        projection.rows_from_tail = if moved < 0 {
            projection
                .rows_from_tail
                .and_then(|distance| distance.checked_add(moved.unsigned_abs()))
        } else {
            projection
                .rows_from_tail
                .and_then(|distance| distance.checked_sub(moved.unsigned_abs()))
        };
        if moved == 0 && projection.rows_from_tail == Some(0) {
            projection.follow_tail = true;
            projection.anchor_status = if delta < 0 {
                ViewportAnchorStatus::ClampedStart
            } else {
                ViewportAnchorStatus::ClampedTail
            };
            projection.anchor = None;
            projection.anchor_logical = None;
            projection.anchor_buffer = None;
        }
        Ok(())
    }
}

fn row_logical_anchor(row: &terminal_state_protocol::TerminalRow) -> LogicalCellAnchor {
    LogicalCellAnchor {
        logical_line_id: row.logical_line_id,
        logical_cell_offset: row.logical_cell_offset,
    }
}

pub struct CapturedViewportFrame {
    terminal_epoch: String,
    through_output_seq: u64,
    state_revision: u64,
    projection_revision: u64,
    geometry: ViewportProjectionGeometry,
    source: CachedViewportSource,
    follow_tail: bool,
    applied_intent_seq: u64,
    anchor_status: ViewportAnchorStatus,
    rows_from_tail: Option<u64>,
    viewport: BoundedViewportRows,
}

impl CapturedViewportFrame {
    pub fn finish(self) -> Result<TerminalStateRecord, TerminalReplayError> {
        let viewport = build_viewport_frame(
            ViewportFrameMetadata {
                projection_revision: self.projection_revision,
                geometry: &self.geometry,
                source: &self.source,
                follow_tail: self.follow_tail,
                applied_intent_seq: self.applied_intent_seq,
                anchor_status: self.anchor_status,
                rows_from_tail: self.rows_from_tail,
            },
            self.viewport,
        )?;
        let record = TerminalStateRecord {
            schema_minor: u32::from(terminal_state_protocol::PROTOCOL_MINOR),
            terminal_epoch: self.terminal_epoch,
            through_output_seq: self.through_output_seq,
            state_revision: self.state_revision,
            body: Some(terminal_state_record::Body::ViewportFrame(viewport)),
        };
        terminal_state_protocol::validate_record(&record).map_err(|_| {
            TerminalReplayError::InvalidStructuredProjection {
                reason: "encoded viewport record failed protocol validation",
            }
        })?;
        Ok(record)
    }
}

pub(super) struct ViewportProjectionCache {
    source: Option<CachedViewportSource>,
}

impl ViewportProjectionCache {
    pub(super) fn new() -> Self {
        Self { source: None }
    }

    fn replace_source(&mut self, source: CachedViewportSource) {
        self.source = Some(source);
    }
}

impl TerminalReplay {
    pub fn attach_view_projection(&mut self) -> Result<ViewProjection, TerminalReplayError> {
        let projection_id = self.next_view_projection_id;
        let viewport_rows = self.terminal.size().0;
        self.next_view_projection_id = projection_id
            .checked_add(1)
            .ok_or(TerminalReplayError::TerminalStateRevisionExhausted)?;
        Ok(ViewProjection::new(
            self.fence.clone(),
            self.viewport_source_owner,
            projection_id,
            viewport_rows,
        ))
    }

    pub fn apply_viewport_intent(
        &mut self,
        projection: &mut ViewProjection,
        ingress: &DecodedRecord,
    ) -> Result<ViewportIntentDisposition, TerminalReplayError> {
        self.route_viewport_intent(projection, ingress, WheelPtySink::Absent)
            .map(|application| application.disposition)
    }

    pub fn route_viewport_intent(
        &mut self,
        projection: &mut ViewProjection,
        ingress: &DecodedRecord,
        wheel_pty_sink: WheelPtySink,
    ) -> Result<ViewportIntentApplication, TerminalReplayError> {
        if !self.owns_view_projection(projection) {
            return Err(TerminalReplayError::InvalidStructuredInput);
        }
        let Some(terminal_state_record::Body::ViewportIntent(intent)) =
            ingress.record.body.as_ref()
        else {
            return Err(TerminalReplayError::InvalidStructuredInput);
        };
        if projection.last_record_id == Some(ingress.metadata.record_id) {
            return if projection.last_intent.as_ref() == Some(intent) {
                Ok(ViewportIntentApplication {
                    disposition: ViewportIntentDisposition::Duplicate,
                    wheel_route: projection.last_wheel_route,
                    pty_bytes: Vec::new(),
                })
            } else {
                Err(TerminalReplayError::InvalidStructuredInput)
            };
        }
        if projection
            .last_record_id
            .is_some_and(|previous| ingress.metadata.record_id < previous)
        {
            return Err(TerminalReplayError::InvalidStructuredInput);
        }
        validate_viewport_ingress(
            &ingress.record,
            &ViewportIngressAuthority {
                terminal_epoch: &self.fence.terminal_epoch,
                projection_revision: projection.projection_revision,
                applied_intent_seq: projection.applied_intent_seq,
            },
        )
        .map_err(|_| TerminalReplayError::InvalidStructuredInput)?;

        let mut wheel_route = None;
        let mut pty_bytes = Vec::new();
        let disposition = match intent
            .intent
            .as_ref()
            .ok_or(TerminalReplayError::InvalidStructuredInput)?
        {
            viewport_intent::Intent::SetViewportRows(rows) => {
                let viewport_rows = u16::try_from(rows.rows)
                    .map_err(|_| TerminalReplayError::InvalidStructuredInput)?;
                if projection.set_viewport_rows(viewport_rows) {
                    ViewportIntentDisposition::Applied
                } else {
                    ViewportIntentDisposition::NoChange
                }
            }
            viewport_intent::Intent::FollowTail(_) => {
                if projection.follow_tail {
                    projection.anchor_status = ViewportAnchorStatus::FollowTail;
                    projection.rows_from_tail = Some(0);
                    ViewportIntentDisposition::NoChange
                } else {
                    projection.follow_tail = true;
                    projection.anchor_status = ViewportAnchorStatus::FollowTail;
                    projection.rows_from_tail = Some(0);
                    projection.anchor = None;
                    projection.anchor_logical = None;
                    projection.anchor_buffer = None;
                    projection.pending_scroll_rows = 0;
                    ViewportIntentDisposition::Applied
                }
            }
            viewport_intent::Intent::ScrollRows(scroll) => {
                self.apply_viewport_scroll(projection, scroll.rows)?
            }
            viewport_intent::Intent::Wheel(wheel) => {
                if wheel_pty_sink == WheelPtySink::Connected {
                    pty_bytes =
                        self.terminal
                            .encode_input(&terminal_state_protocol::InputIntent {
                                intent: Some(
                                    terminal_state_protocol::input_intent::Intent::Pointer(*wheel),
                                ),
                            })?;
                }
                if pty_bytes.is_empty() {
                    wheel_route = Some(WheelIntentRoute::Viewport);
                    if wheel.wheel_delta_y == 0 {
                        ViewportIntentDisposition::NoChange
                    } else {
                        self.apply_viewport_scroll(projection, -wheel.wheel_delta_y)?
                    }
                } else {
                    wheel_route = Some(WheelIntentRoute::Pty);
                    ViewportIntentDisposition::NoChange
                }
            }
            viewport_intent::Intent::TerminalDefaultColors(_) => {
                ViewportIntentDisposition::NoChange
            }
        };
        projection.applied_intent_seq = intent.intent_seq;
        projection.pending_local_change = true;
        projection.last_record_id = Some(ingress.metadata.record_id);
        projection.last_intent = Some(*intent);
        projection.last_wheel_route = wheel_route;
        Ok(ViewportIntentApplication {
            disposition,
            wheel_route,
            pty_bytes,
        })
    }

    fn apply_viewport_scroll(
        &mut self,
        projection: &mut ViewProjection,
        rows: i32,
    ) -> Result<ViewportIntentDisposition, TerminalReplayError> {
        projection
            .viewport_rows
            .ok_or(TerminalReplayError::InvalidStructuredInput)?;
        if projection.follow_tail && rows < 0 {
            projection.anchor_status = ViewportAnchorStatus::ClampedTail;
            projection.rows_from_tail = Some(0);
            return Ok(ViewportIntentDisposition::NoChange);
        }
        if projection.anchor_status == ViewportAnchorStatus::ClampedStart && rows > 0 {
            return Ok(ViewportIntentDisposition::NoChange);
        }
        if rows == 0 {
            Ok(ViewportIntentDisposition::NoChange)
        } else {
            projection.pending_scroll_rows = projection
                .pending_scroll_rows
                .saturating_add(i64::from(rows));
            Ok(ViewportIntentDisposition::Applied)
        }
    }

    pub fn set_view_projection_rows(
        &mut self,
        projection: &mut ViewProjection,
        viewport_rows: u16,
    ) -> Result<bool, TerminalReplayError> {
        if viewport_rows == 0 {
            return Err(TerminalReplayError::InvalidStructuredProjection {
                reason: "requested viewport row count is zero",
            });
        }
        if !self.owns_view_projection(projection) {
            return Err(TerminalReplayError::InvalidStructuredProjection {
                reason: "row resize targets a projection this replay does not own",
            });
        }
        Ok(projection.set_viewport_rows(viewport_rows))
    }

    #[cfg(test)]
    fn take_latest_viewport_frame(
        &mut self,
        projection: &mut ViewProjection,
    ) -> Result<Option<TerminalStateRecord>, TerminalReplayError> {
        self.capture_latest_viewport_frame(projection)?
            .map(CapturedViewportFrame::finish)
            .transpose()
    }

    pub fn capture_latest_viewport_frame(
        &mut self,
        projection: &mut ViewProjection,
    ) -> Result<Option<CapturedViewportFrame>, TerminalReplayError> {
        let request = projection.capture_request().ok_or(
            TerminalReplayError::InvalidStructuredProjection {
                reason: "projection has no capture request",
            },
        )?;
        self.capture_viewport_source(std::slice::from_ref(&request), usize::MAX)?
            .capture_latest_viewport_frame(projection)
    }

    pub fn capture_viewport_source(
        &mut self,
        requests: &[ViewportCaptureRequest],
        maximum_capture_bytes: usize,
    ) -> Result<CapturedViewportSource, TerminalReplayError> {
        if requests.is_empty() {
            return Err(TerminalReplayError::InvalidStructuredProjection {
                reason: "capture was requested for no viewports",
            });
        }
        for request in requests {
            let invalid = if request.viewport_rows == 0 {
                Some("capture request viewport row count is zero")
            } else if request.source_owner != self.viewport_source_owner {
                Some("capture request belongs to another viewport source")
            } else if request.origin_fence != self.fence {
                Some("capture request belongs to another session fence")
            } else {
                None
            };
            if let Some(reason) = invalid {
                return Err(TerminalReplayError::InvalidStructuredProjection { reason });
            }
        }
        let cold = match self.recovered_history_boundary.as_ref() {
            Some(boundary) => Some(boundary.projection_cold.clone()),
            None => self
                .history_transfer
                .is_enabled()
                .then(|| self.history_transfer.store().capture_projection_source())
                .transpose()?,
        };
        let hot = self
            .terminal
            .capture_hot_viewport_source(requests, maximum_capture_bytes)?;
        let accounted_capture_bytes = hot.accounted_capture_bytes();
        let composite = Arc::new(CompositeViewportSource::new(cold, hot));
        let metrics = composite.viewport_metrics()?;
        let source = self.cached_viewport_source(metrics)?;
        Ok(CapturedViewportSource {
            origin_fence: self.fence.clone(),
            source_owner: self.viewport_source_owner,
            through_output_seq: self.output_seq,
            state_revision: self.terminal_state_revision,
            source,
            composite,
            accounted_capture_bytes,
        })
    }

    pub fn detach_view_projection(
        &mut self,
        projection: &mut ViewProjection,
    ) -> Result<(), TerminalReplayError> {
        if !self.owns_view_projection(projection) {
            return Err(TerminalReplayError::InvalidStructuredProjection {
                reason: "detach targets a projection this replay does not own",
            });
        }
        projection.attached = false;
        projection.viewport_rows = None;
        projection.follow_tail = true;
        projection.anchor_status = ViewportAnchorStatus::FollowTail;
        projection.rows_from_tail = Some(0);
        projection.anchor = None;
        projection.anchor_logical = None;
        projection.anchor_buffer = None;
        projection.pending_scroll_rows = 0;
        projection.pending_local_change = false;
        projection.last_intent = None;
        projection.applied_intent_seq = 0;
        #[cfg(test)]
        {
            projection.last_projection_work = None;
        }
        Ok(())
    }

    fn owns_view_projection(&self, projection: &ViewProjection) -> bool {
        projection.attached
            && projection.projection_id != 0
            && projection.source_owner == self.viewport_source_owner
            && projection.origin_fence == self.fence
    }

    fn cached_viewport_source(
        &mut self,
        metrics: TerminalViewportMetrics,
    ) -> Result<CachedViewportSource, TerminalReplayError> {
        if self
            .viewport_projection_cache
            .source
            .as_ref()
            .is_none_or(|source| source.terminal_revision != self.terminal_state_revision)
        {
            let source = CachedViewportSource {
                terminal_revision: self.terminal_state_revision,
                snapshot: Arc::new(self.terminal.viewport_metadata(self.terminal_event_id)?),
                metrics,
            };
            let expected_buffer = ViewProjection::active_buffer(source.metrics);
            if source.snapshot.active_buffer != expected_buffer {
                return Err(TerminalReplayError::InvalidStructuredProjection {
                    reason: "viewport snapshot active buffer disagrees with its metrics",
                });
            }
            self.viewport_projection_cache.replace_source(source);
        }
        self.viewport_projection_cache.source.clone().ok_or(
            TerminalReplayError::InvalidStructuredProjection {
                reason: "viewport source cache is empty",
            },
        )
    }
}

fn viewport_geometry(
    source: &CachedViewportSource,
    viewport_rows: u16,
) -> Result<ViewportProjectionGeometry, TerminalReplayError> {
    let columns = u16::try_from(source.snapshot.columns).map_err(|_| {
        TerminalReplayError::InvalidStructuredProjection {
            reason: "viewport column count exceeds its protocol bound",
        }
    })?;
    let unicode_width = source.snapshot.unicode_width.clone().ok_or(
        TerminalReplayError::InvalidStructuredProjection {
            reason: "viewport snapshot has no unicode width table",
        },
    )?;
    Ok(ViewportProjectionGeometry::new(
        columns,
        viewport_rows,
        source.terminal_revision,
        unicode_width,
    ))
}

struct ViewportFrameMetadata<'a> {
    projection_revision: u64,
    geometry: &'a ViewportProjectionGeometry,
    source: &'a CachedViewportSource,
    follow_tail: bool,
    applied_intent_seq: u64,
    anchor_status: ViewportAnchorStatus,
    rows_from_tail: Option<u64>,
}

fn build_viewport_frame(
    metadata: ViewportFrameMetadata<'_>,
    viewport: BoundedViewportRows,
) -> Result<ViewportFrame, TerminalReplayError> {
    let ViewportFrameMetadata {
        projection_revision,
        geometry,
        source,
        follow_tail,
        applied_intent_seq,
        anchor_status,
        rows_from_tail,
    } = metadata;
    let buffer = match BufferId::try_from(source.snapshot.active_buffer).map_err(|_| {
        TerminalReplayError::InvalidStructuredProjection {
            reason: "viewport snapshot active buffer id is unknown",
        }
    })? {
        BufferId::Normal => source.snapshot.normal_buffer.as_ref(),
        BufferId::Alternate => source.snapshot.alternate_buffer.as_ref(),
        BufferId::Unspecified => None,
    }
    .ok_or(TerminalReplayError::InvalidStructuredProjection {
        reason: "viewport snapshot is missing the active buffer",
    })?;
    // One reason per condition: a shared name would send the peer a sentence
    // that is true of some other failure than the one that happened.
    let emitted_cells = viewport
        .rows
        .iter()
        .map(|row| row.cells.len())
        .sum::<usize>();
    let incomplete = if viewport.rows.is_empty() {
        Some("projected viewport produced no rows")
    } else if viewport.rows.len() > usize::from(geometry.viewport_rows) {
        Some("projected viewport emitted more rows than its geometry allows")
    } else if viewport.visited_rows < viewport.rows.len() {
        Some("projected viewport emitted more rows than it visited")
    } else if viewport.visited_rows > geometry.visit_budget {
        Some("projected viewport exceeded its row visit budget")
    } else if viewport.work.chunks_visited == 0 {
        Some("projected viewport visited no source chunks")
    } else if viewport.work.cells_visited < emitted_cells {
        Some("projected viewport emitted more cells than it visited")
    } else if follow_tail && viewport.has_more_after {
        Some("tail-following viewport still reports rows after its last one")
    } else {
        None
    };
    if let Some(reason) = incomplete {
        return Err(TerminalReplayError::InvalidStructuredProjection { reason });
    }

    let cursor = viewport
        .cursor
        .zip(buffer.cursor.as_ref())
        .map(|((row, column), cursor)| {
            let mut cursor = *cursor;
            cursor.row = u32::from(row);
            cursor.column = u32::from(column);
            cursor.style_index = 0;
            Ok(cursor)
        })
        .transpose()?;
    Ok(ViewportFrame {
        projection_revision,
        damage_base_projection_revision: 0,
        canonical_columns: source.snapshot.columns,
        viewport_rows: u32::from(geometry.viewport_rows),
        active_buffer: source.snapshot.active_buffer,
        rows: viewport.rows,
        tables: Some(viewport.tables),
        cursor,
        input_modes: source.snapshot.input_modes,
        color_overrides: Some(viewport.color_overrides),
        unicode_width: source.snapshot.unicode_width.clone(),
        through_event_id: source.snapshot.through_event_id,
        title: source.snapshot.title.clone(),
        working_directory_uri: source.snapshot.working_directory_uri.clone(),
        follow_tail,
        has_more_before: viewport.has_more_before,
        has_more_after: viewport.has_more_after,
        changed_row_indices: Vec::new(),
        applied_intent_seq,
        anchor_status: anchor_status as i32,
        rows_from_tail,
        input_output_timing: None,
    })
}

#[cfg(test)]
mod tests {
    use terminal_state_protocol::{
        ColorKind, EnvelopeMetadata, PointerInputIntent, PointerKind, RecordKind, ScrollRows,
        SetViewportRows, TerminalStateRecord, UnderlineKind, ViewportFrame, ViewportIntent,
        terminal_state_record, viewport_intent,
    };

    use super::*;
    use crate::local_discovery::{DiscoveryKey, DiscoveryRoot};
    use crate::local_protocol::SessionFence;
    use crate::terminal_replay::{TerminalCheckpoint, TerminalReplayLimits};
    use std::sync::{Arc, Barrier, Mutex, mpsc};

    struct ParkedViewportAnchor {
        inner: Box<dyn TerminalViewportAnchor>,
        entered: Mutex<Option<mpsc::Sender<()>>>,
        release: Mutex<mpsc::Receiver<()>>,
    }

    impl TerminalViewportAnchor for ParkedViewportAnchor {
        fn move_rows(
            &mut self,
            delta: i64,
            geometry: &ViewportProjectionGeometry,
        ) -> Result<i64, ViewportAnchorError> {
            self.inner.move_rows(delta, geometry)
        }

        fn project_rows(
            &self,
            geometry: &ViewportProjectionGeometry,
        ) -> Result<BoundedViewportRows, ViewportAnchorError> {
            if let Some(entered) = self.entered.lock().unwrap().take() {
                entered.send(()).unwrap();
                self.release.lock().unwrap().recv().unwrap();
            }
            self.inner.project_rows(geometry)
        }
    }

    fn replay() -> TerminalReplay {
        TerminalReplay::new(
            SessionFence {
                workspace_id: "workspace".into(),
                session_id: "session".into(),
                runner_principal: "runner".into(),
                runner_instance: "runner-1".into(),
                channel_epoch: 1,
                host_instance_id: "host-1".into(),
                terminal_epoch: "terminal-view-projection".into(),
            },
            4,
            24,
            TerminalReplayLimits::default(),
        )
        .unwrap()
    }

    fn ingress(
        replay: &TerminalReplay,
        record_id: u64,
        observed_projection_revision: u64,
        intent: viewport_intent::Intent,
    ) -> DecodedRecord {
        DecodedRecord {
            metadata: EnvelopeMetadata {
                protocol_minor: terminal_state_protocol::PROTOCOL_MINOR,
                record_id,
                kind: RecordKind::ViewportIntent,
            },
            record: TerminalStateRecord {
                schema_minor: u32::from(terminal_state_protocol::PROTOCOL_MINOR),
                terminal_epoch: replay.fence().terminal_epoch.clone(),
                through_output_seq: replay.current_output_seq(),
                state_revision: replay.current_terminal_state_revision(),
                body: Some(terminal_state_record::Body::ViewportIntent(
                    ViewportIntent {
                        observed_projection_revision,
                        intent_seq: record_id,
                        intent: Some(intent),
                    },
                )),
            },
        }
    }

    fn configure(
        replay: &mut TerminalReplay,
        projection: &mut ViewProjection,
        record_id: u64,
        rows: u32,
    ) {
        let input = ingress(
            replay,
            record_id,
            projection.projection_revision,
            viewport_intent::Intent::SetViewportRows(SetViewportRows { rows }),
        );
        replay.apply_viewport_intent(projection, &input).unwrap();
    }

    fn scroll(
        replay: &mut TerminalReplay,
        projection: &mut ViewProjection,
        record_id: u64,
        rows: i32,
    ) {
        let input = ingress(
            replay,
            record_id,
            projection.projection_revision,
            viewport_intent::Intent::ScrollRows(ScrollRows { rows }),
        );
        replay.apply_viewport_intent(projection, &input).unwrap();
    }

    fn take_frame(
        replay: &mut TerminalReplay,
        projection: &mut ViewProjection,
    ) -> TerminalStateRecord {
        replay
            .take_latest_viewport_frame(projection)
            .unwrap()
            .expect("dirty projection must yield one complete frame")
    }

    fn frame(record: &TerminalStateRecord) -> &ViewportFrame {
        let Some(terminal_state_record::Body::ViewportFrame(frame)) = record.body.as_ref() else {
            panic!("projection output must be a viewport frame");
        };
        frame
    }

    fn protocol_round_trip(record: TerminalStateRecord, record_id: u64) -> TerminalStateRecord {
        let encoded = terminal_state_protocol::encode_record(record_id, &record).unwrap();
        let decoded = terminal_state_protocol::decode_record(&encoded).unwrap();
        assert_eq!(decoded.metadata.record_id, record_id);
        decoded.record
    }

    fn row_text(frame: &ViewportFrame, row: usize) -> String {
        let tables = frame.tables.as_ref().unwrap();
        frame.rows[row]
            .cells
            .iter()
            .map(|cell| tables.graphemes[cell.grapheme_index as usize].text.as_str())
            .collect::<String>()
            .trim_end()
            .to_string()
    }

    fn assert_numbered_line_style(frame: &ViewportFrame, row: usize, marker: &str) {
        assert!(row_text(frame, row).starts_with(marker));
        let tables = frame.tables.as_ref().unwrap();
        let first = frame.rows[row].cells.first().unwrap();
        assert_eq!(
            tables.graphemes[first.grapheme_index as usize].text,
            marker[..1]
        );
        let style = &tables.styles[first.style_index as usize];
        let line_number = marker[1..].parse::<usize>().unwrap();
        let foreground = style.foreground.as_ref().expect("explicit foreground");
        let background = style.background.as_ref().expect("explicit background");
        let underline_color = style
            .underline_color
            .as_ref()
            .expect("explicit underline color");
        if line_number % 2 == 0 {
            assert_eq!(foreground.kind, ColorKind::Palette as i32);
            assert_eq!(foreground.value, 196);
            assert_eq!(background.kind, ColorKind::Rgb as i32);
            assert_eq!(background.value, 0x0c_22_38);
            assert_eq!(underline_color.kind, ColorKind::Palette as i32);
            assert_eq!(underline_color.value, 45);
        } else {
            assert_eq!(foreground.kind, ColorKind::Rgb as i32);
            assert_eq!(foreground.value, 0x11_22_33);
            assert_eq!(background.kind, ColorKind::Palette as i32);
            assert_eq!(background.value, 25);
            assert_eq!(underline_color.kind, ColorKind::Rgb as i32);
            assert_eq!(underline_color.value, 0x44_55_66);
        }
        assert_eq!(style.flags, 1, "bold must survive the cold PAGE path");
        assert_eq!(style.underline, UnderlineKind::Single as i32);
    }

    fn styled_numbered_line(index: usize) -> String {
        let marker = format!("H{index:06}");
        let style = if index % 2 == 0 {
            "\x1b[1;4;38;5;196;48;2;12;34;56;58;5;45m"
        } else {
            "\x1b[1;4;38;2;17;34;51;48;5;25;58;2;68;85;102m"
        };
        format!(
            "{style}{marker}{}\x1b[0m\r\n",
            "x".repeat(80 - marker.len())
        )
    }

    #[cfg(feature = "ghostty-core-proof")]
    fn wait_for_cold_storage(replay: &mut TerminalReplay) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while std::time::Instant::now() < deadline {
            if replay.reconcile_terminal_history().unwrap() {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
        panic!("cold PAGE publication did not settle");
    }

    #[cfg(feature = "ghostty-core-proof")]
    fn checkpoint_after_cold_storage_settles(replay: &mut TerminalReplay) -> TerminalCheckpoint {
        wait_for_cold_storage(replay);
        replay.checkpoint().unwrap()
    }

    fn populate(replay: &mut TerminalReplay, prefix: &str, count: usize) {
        for index in 0..count {
            replay
                .ingest_output(format!("{prefix}-{index:02}\r\n").as_bytes())
                .unwrap();
        }
    }

    fn wheel(delta_y: i32) -> viewport_intent::Intent {
        viewport_intent::Intent::Wheel(PointerInputIntent {
            kind: PointerKind::Wheel as i32,
            column: 2,
            row: 1,
            button: 0,
            modifiers: 0,
            wheel_delta_x: 0,
            wheel_delta_y: delta_y,
            pixel_x: 25,
            pixel_y: 25,
            surface_width: 800,
            surface_height: 600,
            cell_width: 10,
            cell_height: 20,
            padding_top: 0,
            padding_bottom: 0,
            padding_right: 0,
            padding_left: 0,
            pressed_buttons: 0,
        })
    }

    /// Every structured projection invariant used to fail with one sentence,
    /// so a Host that closed an attachment could not say which one broke and
    /// unrelated defects arrived as the same report. Distinct invariants must
    /// stay distinguishable from the message alone.
    #[test]
    fn distinct_projection_invariants_report_distinct_reasons() {
        let mut owner = replay();
        let mut other = replay();
        let mut projection = owner.attach_view_projection().unwrap();
        let mut foreign = other.attach_view_projection().unwrap();

        let zero_rows = owner
            .set_view_projection_rows(&mut projection, 0)
            .unwrap_err()
            .to_string();
        let not_owned = owner
            .detach_view_projection(&mut foreign)
            .unwrap_err()
            .to_string();

        assert_ne!(
            zero_rows, not_owned,
            "two different projection invariants reported the same message"
        );
        assert!(
            zero_rows.contains("row count is zero"),
            "reason must name the invariant: {zero_rows}"
        );
        assert!(
            not_owned.contains("does not own"),
            "reason must name the invariant: {not_owned}"
        );
    }

    #[test]
    fn fresh_attachment_emits_a_complete_tail_frame_before_any_intent() {
        let mut replay = replay();
        populate(&mut replay, "initial", 4);
        let mut projection = replay.attach_view_projection().unwrap();

        let initial = take_frame(&mut replay, &mut projection);

        assert_eq!(frame(&initial).applied_intent_seq, 0);
        assert!(frame(&initial).follow_tail);
        assert!(!frame(&initial).rows.is_empty());
        terminal_state_protocol::validate_record(&initial).unwrap();
    }

    #[test]
    fn scrolling_past_tail_reuses_the_complete_captured_viewport() {
        for downward_rows in [1, 2, 64] {
            let mut replay = replay();
            populate(&mut replay, "history", 40);
            let mut projection = replay.attach_view_projection().unwrap();
            let initial = take_frame(&mut replay, &mut projection);

            scroll(&mut replay, &mut projection, 1, 1);
            let above_tail = take_frame(&mut replay, &mut projection);
            assert!(!frame(&above_tail).follow_tail);

            scroll(&mut replay, &mut projection, 2, -downward_rows);
            let returned = replay
                .take_latest_viewport_frame(&mut projection)
                .unwrap_or_else(|error| {
                    panic!("scrolling down {downward_rows} rows must not retire the projection: {error}")
                })
                .expect("returning to the tail yields a complete frame");
            let returned = frame(&returned);
            assert!(returned.follow_tail);
            assert!(!returned.has_more_after);
            assert_eq!(returned.rows_from_tail, Some(0));
            assert_eq!(returned.applied_intent_seq, 2);
            assert_eq!(returned.rows.len(), frame(&initial).rows.len());
            for row in 0..returned.rows.len() {
                assert_eq!(row_text(returned, row), row_text(frame(&initial), row));
            }
        }
    }

    #[test]
    fn detached_projection_commit_rejects_a_superseded_scalar_base() {
        let mut replay = replay();
        replay.ingest_output(b"seed").unwrap();
        let mut canonical = replay.attach_view_projection().unwrap();
        let request = canonical.capture_request().unwrap();
        let source = replay
            .capture_viewport_source(&[request], usize::MAX)
            .unwrap();
        let mut first = canonical.fork_for_projection();
        let mut superseded = canonical.fork_for_projection();

        assert!(
            source
                .capture_latest_viewport_frame(&mut first)
                .unwrap()
                .is_some()
        );
        assert!(
            source
                .capture_latest_viewport_frame(&mut superseded)
                .unwrap()
                .is_some()
        );
        assert!(canonical.commit_projected(first).unwrap());
        assert!(!canonical.commit_projected(superseded).unwrap());
        assert_eq!(canonical.projection_revision, 1);
    }

    #[cfg(feature = "ghostty-core-proof")]
    #[test]
    fn non_projecting_output_still_advances_the_viewport_high_water() {
        let mut replay = replay();
        let mut projection = replay.attach_view_projection().unwrap();
        let initial = replay
            .capture_latest_viewport_frame(&mut projection)
            .unwrap()
            .expect("initial viewport")
            .finish()
            .unwrap();
        assert_eq!(initial.through_output_seq, 0);

        let ingested = replay.ingest_output(b"\x1b[31m").unwrap();
        assert_eq!(ingested.output_seq, 1);
        assert!(!ingested.projection_changed);

        let next = replay
            .capture_latest_viewport_frame(&mut projection)
            .unwrap()
            .expect("the output high-water must advance even when the visible cells do not")
            .finish()
            .unwrap();
        assert_eq!(next.through_output_seq, 1);
        assert_eq!(next.state_revision, initial.state_revision);
    }

    #[test]
    fn parked_frame_completion_does_not_block_bounded_pty_ingest_or_latest_catch_up() {
        let mut replay = replay();
        replay.ingest_output(b"seed").unwrap();
        let mut projection = replay.attach_view_projection().unwrap();
        let captured = replay
            .capture_latest_viewport_frame(&mut projection)
            .unwrap()
            .expect("the initial native projection must be captured");
        let parked = Arc::new(Barrier::new(2));
        let release = Arc::new(Barrier::new(2));
        let worker_parked = Arc::clone(&parked);
        let worker_release = Arc::clone(&release);
        let worker = std::thread::spawn(move || {
            worker_parked.wait();
            worker_release.wait();
            captured.finish()
        });
        parked.wait();

        let initial_revision = replay.current_terminal_state_revision();
        for index in 0..100_000 {
            let cursor_motion: &[u8] = if index % 2 == 0 {
                b"\x1b[1;1H"
            } else {
                b"\x1b[2;1H"
            };
            replay.ingest_output(cursor_motion).unwrap();
        }
        replay.ingest_output(b"LATEST").unwrap();
        assert_eq!(replay.current_output_seq(), 100_002);
        assert!(replay.earliest_retained_output_seq() > 1);
        assert!(replay.current_terminal_state_revision() > initial_revision);

        release.wait();
        let parked_frame = worker.join().unwrap().unwrap();
        let latest = replay
            .capture_latest_viewport_frame(&mut projection)
            .unwrap()
            .expect("the latest native projection must replace the parked capture")
            .finish()
            .unwrap();
        assert_eq!(latest.through_output_seq, replay.current_output_seq());
        assert!(latest.state_revision > parked_frame.state_revision);
        assert!(
            frame(&latest)
                .rows
                .iter()
                .enumerate()
                .any(|(row, _)| row_text(frame(&latest), row).contains("LATEST"))
        );
        assert!(
            replay
                .take_latest_viewport_frame(&mut projection)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn parked_anchor_projection_does_not_block_terminal_mutation_or_another_attachment() {
        let mut replay = replay();
        let mut history = String::new();
        for index in 0..4_000 {
            history.push_str(&format!("H{index:04}\r\n"));
        }
        replay.ingest_output(history.as_bytes()).unwrap();
        let mut parked_projection = replay.attach_view_projection().unwrap();
        configure(&mut replay, &mut parked_projection, 1, 3);
        let _ = take_frame(&mut replay, &mut parked_projection);
        scroll(&mut replay, &mut parked_projection, 2, 5);
        let _ = take_frame(&mut replay, &mut parked_projection);

        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        parked_projection.anchor = Some(Box::new(ParkedViewportAnchor {
            inner: parked_projection
                .anchor
                .take()
                .expect("scroll creates an anchor"),
            entered: Mutex::new(Some(entered_tx)),
            release: Mutex::new(release_rx),
        }));
        parked_projection.anchor_logical = None;
        parked_projection.pending_local_change = true;

        let parked_request = parked_projection.capture_request().unwrap();
        let parked_source = replay
            .capture_viewport_source(std::slice::from_ref(&parked_request), usize::MAX)
            .unwrap();
        let replay = Arc::new(Mutex::new(replay));
        let parked = std::thread::spawn(move || {
            parked_source.capture_latest_viewport_frame(&mut parked_projection)
        });
        entered_rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .expect("the real anchor source projection must be parked");

        let progress_replay = Arc::clone(&replay);
        let (progress_tx, progress_rx) = mpsc::channel();
        let progress = std::thread::spawn(move || {
            let mut replay = progress_replay.lock().unwrap();
            let mut live_projection = replay.attach_view_projection().unwrap();
            configure(&mut replay, &mut live_projection, 1, 3);
            let initial_revision = replay.current_terminal_state_revision();
            for index in 0..100_000 {
                let cursor_motion: &[u8] = if index % 2 == 0 {
                    b"\x1b[1;1H"
                } else {
                    b"\x1b[2;1H"
                };
                replay.ingest_output(cursor_motion).unwrap();
            }
            replay.resize(5, 24).unwrap();
            let encoded_input = replay
                .encode_structured_input(&terminal_state_protocol::InputIntent {
                    intent: Some(terminal_state_protocol::input_intent::Intent::Text(
                        terminal_state_protocol::TextInputIntent {
                            utf8: b"input".to_vec(),
                        },
                    )),
                })
                .unwrap();
            assert_eq!(encoded_input, b"input");
            let output_seq = replay.current_output_seq();
            let state_revision = replay.current_terminal_state_revision();
            let latest_request = live_projection.capture_request().unwrap();
            let latest_source = replay
                .capture_viewport_source(std::slice::from_ref(&latest_request), usize::MAX)
                .unwrap();
            drop(replay);
            let latest = latest_source
                .capture_latest_viewport_frame(&mut live_projection)
                .unwrap()
                .expect("the independent attachment must reach the latest generation")
                .finish()
                .unwrap();
            progress_tx
                .send((output_seq, state_revision, initial_revision, latest))
                .unwrap();
        });

        let observed = progress_rx
            .recv_timeout(std::time::Duration::from_secs(15))
            .expect(
                "a parked projection and large hot history must not delay 100k terminal mutations",
            );
        release_tx.send(()).unwrap();
        let _ = parked.join().unwrap().unwrap();
        progress.join().unwrap();
        let (output_seq, state_revision, initial_revision, latest) = observed;
        assert_eq!(output_seq, 100_001);
        assert_eq!(state_revision, initial_revision + 100_001);
        assert_eq!(latest.through_output_seq, output_seq);
        assert_eq!(latest.state_revision, state_revision);
    }

    #[test]
    fn slow_projection_work_never_holds_pty_ingest() {
        let replay = Arc::new(Mutex::new(replay()));
        let mut projection = {
            let mut replay = replay.lock().unwrap();
            replay.ingest_output(b"seed").unwrap();
            replay.attach_view_projection().unwrap()
        };
        let gate = super::super::ghostty_core_proof::ProjectionWorkGate::new();
        let projection_gate = Arc::clone(&gate);
        let capture_replay = Arc::clone(&replay);
        let capture = std::thread::spawn(move || {
            let _installed =
                super::super::ghostty_core_proof::install_projection_work_gate(projection_gate);
            let source = {
                let mut replay = capture_replay.lock().unwrap();
                let request = projection.capture_request().unwrap();
                replay.capture_viewport_source(std::slice::from_ref(&request), usize::MAX)?
            };
            source
                .capture_latest_viewport_frame(&mut projection)?
                .map(CapturedViewportFrame::finish)
                .transpose()
        });

        assert!(
            gate.wait_entered(std::time::Duration::from_secs(1)),
            "immutable projection work must reach the deliberate stall"
        );

        let ingest_replay = Arc::clone(&replay);
        let (ingest_done_tx, ingest_done_rx) = mpsc::sync_channel(1);
        let ingest = std::thread::spawn(move || {
            let result = ingest_replay
                .lock()
                .unwrap()
                .ingest_output(b"after-capture");
            let _ = ingest_done_tx.send(result);
        });
        let progressed = ingest_done_rx.recv_timeout(std::time::Duration::from_millis(100));
        gate.release();
        let capture_result = capture.join().unwrap();
        ingest.join().unwrap();

        assert!(
            progressed.is_ok_and(|result| result.is_ok()),
            "PTY ingest waited behind immutable projection work"
        );
        capture_result.unwrap();
    }

    #[test]
    fn two_attached_surfaces_scroll_independently() {
        let mut replay = replay();
        populate(&mut replay, "history", 18);
        let mut left = replay.attach_view_projection().unwrap();
        let mut right = replay.attach_view_projection().unwrap();
        configure(&mut replay, &mut left, 1, 3);
        configure(&mut replay, &mut right, 1, 3);
        let _ = take_frame(&mut replay, &mut left);
        let _ = take_frame(&mut replay, &mut right);

        scroll(&mut replay, &mut left, 2, 5);
        let left_scrolled = take_frame(&mut replay, &mut left);
        assert!(!frame(&left_scrolled).follow_tail);
        assert!(
            replay
                .take_latest_viewport_frame(&mut right)
                .unwrap()
                .is_none()
        );

        replay.ingest_output(b"history-tail\r\n").unwrap();
        let left_after_output = take_frame(&mut replay, &mut left);
        let right_after_output = take_frame(&mut replay, &mut right);
        assert!(!frame(&left_after_output).follow_tail);
        assert!(frame(&right_after_output).follow_tail);
        assert_ne!(
            row_text(frame(&left_after_output), 0),
            row_text(frame(&right_after_output), 0),
        );
    }

    #[test]
    fn wheel_preserves_normal_history_delta_magnitude() {
        let mut replay = replay();
        populate(&mut replay, "wheel-history", 20);
        let mut projection = replay.attach_view_projection().unwrap();
        configure(&mut replay, &mut projection, 1, 3);
        let initial = take_frame(&mut replay, &mut projection);
        let interaction = ingress(&replay, 2, frame(&initial).projection_revision, wheel(-4));

        let application = replay
            .route_viewport_intent(&mut projection, &interaction, WheelPtySink::Connected)
            .unwrap();
        let scrolled = take_frame(&mut replay, &mut projection);

        assert_eq!(application.wheel_route, Some(WheelIntentRoute::Viewport));
        assert!(application.pty_bytes.is_empty());
        assert_eq!(application.disposition, ViewportIntentDisposition::Applied);
        assert_eq!(frame(&scrolled).rows_from_tail, Some(4));
        assert_eq!(frame(&scrolled).applied_intent_seq, 2);
        assert_ne!(row_text(frame(&initial), 0), row_text(frame(&scrolled), 0));
    }

    #[cfg(feature = "ghostty-core-proof")]
    #[test]
    fn recovered_visible_rows_survive_successor_redraw_as_normal_history() {
        let mut source = replay();
        source
            .ingest_output(b"SOURCE_CONTEXT_A\r\nSOURCE_CONTEXT_B\r\nLATEST_SOURCE_EXCHANGE")
            .unwrap();
        let checkpoint = source.checkpoint().unwrap();
        let source_fence = checkpoint.fence.clone();
        let mut successor_fence = source_fence.clone();
        successor_fence.session_id = "successor-session".into();
        successor_fence.runner_instance = "runner-2".into();
        successor_fence.host_instance_id = "host-2".into();
        successor_fence.terminal_epoch = "terminal-successor".into();
        let mut successor =
            TerminalReplay::new(successor_fence, 4, 24, TerminalReplayLimits::default()).unwrap();
        successor
            .restore_checkpoint(
                crate::local_protocol::RecoveredPresentation {
                    source_fence,
                    sequence_through: checkpoint.sequence_through,
                    captured_unix_ms: 1,
                    truncated: false,
                },
                checkpoint,
            )
            .unwrap();

        successor
            .ingest_output(b"\x1b[2J\x1b[HSUCCESSOR_REDRAW_A\r\nSUCCESSOR_REDRAW_B")
            .unwrap();
        let mut projection = successor.attach_view_projection().unwrap();
        configure(&mut successor, &mut projection, 1, 3);
        let tail = take_frame(&mut successor, &mut projection);
        assert!(
            (0..frame(&tail).rows.len())
                .any(|row| row_text(frame(&tail), row).contains("SUCCESSOR_REDRAW"))
        );

        scroll(&mut successor, &mut projection, 2, 4);
        let history = take_frame(&mut successor, &mut projection);
        assert!(
            (0..frame(&history).rows.len())
                .any(|row| row_text(frame(&history), row).contains("LATEST_SOURCE_EXCHANGE")),
            "the exact pre-rehost visible exchange must remain reachable through Host-owned history"
        );
    }

    #[test]
    fn alternate_screen_mouse_mode_routes_wheel_to_the_pty() {
        let mut replay = replay();
        replay
            .ingest_output(b"\x1b[?1049h\x1b[?1000h\x1b[HALTERNATE")
            .unwrap();
        let mut projection = replay.attach_view_projection().unwrap();
        configure(&mut replay, &mut projection, 1, 3);
        let presented = take_frame(&mut replay, &mut projection);
        assert_eq!(frame(&presented).active_buffer, BufferId::Alternate as i32);
        assert_ne!(
            frame(&presented)
                .input_modes
                .as_ref()
                .unwrap()
                .mouse_tracking,
            terminal_state_protocol::MouseTrackingMode::None as i32,
        );
        let interaction = ingress(&replay, 2, frame(&presented).projection_revision, wheel(-3));

        let application = replay
            .route_viewport_intent(&mut projection, &interaction, WheelPtySink::Connected)
            .unwrap();

        assert_eq!(application.wheel_route, Some(WheelIntentRoute::Pty));
        assert_eq!(application.disposition, ViewportIntentDisposition::NoChange);
        assert!(!application.pty_bytes.is_empty());
    }

    #[test]
    fn wheel_route_uses_current_engine_mouse_mode_not_the_last_presented_frame() {
        let mut replay = replay();
        populate(&mut replay, "wheel", 8);
        let mut projection = replay.attach_view_projection().unwrap();
        configure(&mut replay, &mut projection, 1, 3);
        let presented = take_frame(&mut replay, &mut projection);
        assert_eq!(
            frame(&presented)
                .input_modes
                .as_ref()
                .unwrap()
                .mouse_tracking,
            terminal_state_protocol::MouseTrackingMode::None as i32,
        );

        replay.ingest_output(b"\x1b[?1000h").unwrap();
        let interaction = ingress(&replay, 2, frame(&presented).projection_revision, wheel(-3));
        let application = replay
            .route_viewport_intent(&mut projection, &interaction, WheelPtySink::Connected)
            .unwrap();

        assert_eq!(application.wheel_route, Some(WheelIntentRoute::Pty));
        assert!(!application.pty_bytes.is_empty());
    }

    #[test]
    fn a_skipped_projection_revision_is_safe_to_install_from_empty() {
        let mut replay = replay();
        populate(&mut replay, "skip", 20);
        let mut projection = replay.attach_view_projection().unwrap();
        configure(&mut replay, &mut projection, 1, 3);
        let _first = take_frame(&mut replay, &mut projection);

        scroll(&mut replay, &mut projection, 2, 2);
        let _skipped = take_frame(&mut replay, &mut projection);
        scroll(&mut replay, &mut projection, 3, 2);
        let installed = take_frame(&mut replay, &mut projection);

        assert_eq!(frame(&installed).damage_base_projection_revision, 0);
        terminal_state_protocol::validate_record(&installed).unwrap();
        assert!(!row_text(frame(&installed), 0).is_empty());
    }

    #[test]
    fn canonical_reflow_preserves_an_anchor_while_tail_stays_at_tail() {
        let mut replay = replay();
        populate(&mut replay, "anchor-abcdefgh", 18);
        let mut anchored = replay.attach_view_projection().unwrap();
        let mut tail = replay.attach_view_projection().unwrap();
        configure(&mut replay, &mut anchored, 1, 3);
        configure(&mut replay, &mut tail, 1, 3);
        let _ = take_frame(&mut replay, &mut anchored);
        let _ = take_frame(&mut replay, &mut tail);
        scroll(&mut replay, &mut anchored, 2, 5);
        let before = take_frame(&mut replay, &mut anchored);
        let marker = row_text(frame(&before), 0)
            .chars()
            .take(9)
            .collect::<String>();

        replay.resize(4, 12).unwrap();
        let anchored_after = take_frame(&mut replay, &mut anchored);
        let tail_after = take_frame(&mut replay, &mut tail);

        assert!(!frame(&anchored_after).follow_tail);
        assert!(row_text(frame(&anchored_after), 0).contains(&marker));
        assert!(frame(&tail_after).follow_tail);
        assert!(!frame(&tail_after).has_more_after);
    }

    #[cfg(feature = "ghostty-core-proof")]
    #[test]
    fn ghostty_alternate_viewport_keeps_hot_row_ids_in_its_namespace() {
        let mut replay = replay();
        replay
            .ingest_output(b"\x1b[?1049h\x1b[HALTERNATE_VIEWPORT")
            .unwrap();
        let mut projection = replay.attach_view_projection().unwrap();
        configure(&mut replay, &mut projection, 1, 3);

        let record = take_frame(&mut replay, &mut projection);
        let frame = frame(&record);

        assert_eq!(frame.active_buffer, BufferId::Alternate as i32);
        assert!(frame.rows.iter().all(|row| row.row_id & (1 << 63) == 0));
    }

    #[cfg(feature = "ghostty-core-proof")]
    #[test]
    fn ghostty_cold_anchor_survives_history_cap_and_reflow() {
        let mut replay = TerminalReplay::new(
            SessionFence {
                workspace_id: "workspace".into(),
                session_id: "session".into(),
                runner_principal: "runner".into(),
                runner_instance: "runner-1".into(),
                channel_epoch: 1,
                host_instance_id: "host-1".into(),
                terminal_epoch: "terminal-cold-history".into(),
            },
            4,
            80,
            TerminalReplayLimits::default(),
        )
        .unwrap();
        for batch_start in (0..3_000).step_by(500) {
            let mut output = String::new();
            for index in batch_start..usize::min(batch_start + 500, 3_000) {
                let marker = format!("H{index:06}");
                output.push_str(&marker);
                output.extend(std::iter::repeat_n('x', 80 - marker.len()));
                output.push_str("\r\n");
            }
            replay
                .ingest_output(output.as_bytes())
                .unwrap_or_else(|error| panic!("batch {batch_start}: {error:?}"));
        }

        let mut projection = replay.attach_view_projection().unwrap();
        configure(&mut replay, &mut projection, 1, 8);
        let _tail = take_frame(&mut replay, &mut projection);
        let mut hot_anchor = None;
        for record_id in 2..=4 {
            scroll(&mut replay, &mut projection, record_id, 2_048);
            hot_anchor = Some(take_frame(&mut replay, &mut projection));
        }
        assert_eq!(
            row_text(frame(&hot_anchor.unwrap()), 0),
            format!("H000000{}", "x".repeat(73))
        );

        // Keep the live projection anchored while the supplier moves its
        // backing logical line from Ghostty into cold storage.
        for batch_start in (3_000..5_001).step_by(500) {
            let mut output = String::new();
            for index in batch_start..usize::min(batch_start + 500, 5_001) {
                let marker = format!("H{index:06}");
                output.push_str(&marker);
                output.extend(std::iter::repeat_n('x', 80 - marker.len()));
                output.push_str("\r\n");
            }
            replay.ingest_output(output.as_bytes()).unwrap();
        }
        wait_for_cold_storage(&mut replay);
        let before = take_frame(&mut replay, &mut projection);
        let before = frame(&before);

        let (visited_before, work_before) = projection.projection_work();
        assert!(visited_before <= 12);
        assert!(
            work_before.index_nodes_visited <= 128,
            "bounded cold index work: {work_before:?}"
        );
        assert!(work_before.chunks_visited <= 16, "{work_before:?}");
        assert!(work_before.cells_visited <= 12 * 1_024, "{work_before:?}");
        assert!(
            replay
                .history_transfer
                .store()
                .capture_projection_source()
                .unwrap()
                .visible_history_state()
                .logical_line_count
                > 0
        );
        assert!(replay.terminal.retained_physical_rows() < 5_001);

        assert!(!before.follow_tail);
        assert_eq!(row_text(before, 0), format!("H000000{}", "x".repeat(73)));
        let logical_anchor = (
            before.rows[0].logical_line_id,
            before.rows[0].logical_cell_offset,
        );

        wait_for_cold_storage(&mut replay);
        replay.resize(4, 79).unwrap();
        let after = take_frame(&mut replay, &mut projection);
        let after = frame(&after);

        let (visited_after, work_after) = projection.projection_work();
        assert!(visited_after <= 12);
        assert!(
            work_after.index_nodes_visited <= 128,
            "bounded cold index work after reflow: {work_after:?}"
        );
        assert!(work_after.chunks_visited <= 16, "{work_after:?}");
        assert!(work_after.cells_visited <= 12 * 1_024, "{work_after:?}");

        assert!(!after.follow_tail);
        assert_eq!(row_text(after, 0), format!("H000000{}", "x".repeat(72)));
        assert_eq!(
            (
                after.rows[0].logical_line_id,
                after.rows[0].logical_cell_offset,
            ),
            logical_anchor,
        );
    }

    #[cfg(feature = "ghostty-core-proof")]
    #[test]
    fn ghostty_cold_projection_bounds_work_for_a_128k_soft_wrapped_line() {
        let mut replay = TerminalReplay::new(
            SessionFence {
                workspace_id: "workspace".into(),
                session_id: "session".into(),
                runner_principal: "runner".into(),
                runner_instance: "runner-1".into(),
                channel_epoch: 1,
                host_instance_id: "host-1".into(),
                terminal_epoch: "terminal-cold-long-line".into(),
            },
            4,
            1_024,
            TerminalReplayLimits::default(),
        )
        .unwrap();
        for _ in 0..4 {
            replay
                .ingest_output("x".repeat(32 * 1024).as_bytes())
                .unwrap();
        }
        replay.ingest_output(b"\r\n").unwrap();
        for index in 0..32 {
            replay
                .ingest_output(format!("TAIL{index:02}\r\n").as_bytes())
                .unwrap();
        }

        let mut projection = replay.attach_view_projection().unwrap();
        configure(&mut replay, &mut projection, 1, 8);
        let _tail = take_frame(&mut replay, &mut projection);
        scroll(&mut replay, &mut projection, 2, 2_048);
        let anchored = take_frame(&mut replay, &mut projection);
        assert_eq!(frame(&anchored).rows[0].logical_cell_offset, 0);

        // Move the tracked line beyond the bounded hot grid. The cold owner
        // must retain Ghostty's logical identity without resolving or
        // rewrapping all 128 KiB to move one projected row.
        for batch_start in (0..5_001).step_by(1_500) {
            let mut output = String::new();
            for index in batch_start..usize::min(batch_start + 1_500, 5_001) {
                output.push_str(&format!("H{index:06}\r\n"));
            }
            replay
                .ingest_output(output.as_bytes())
                .unwrap_or_else(|error| panic!("batch {batch_start}: {error:?}"));
        }
        wait_for_cold_storage(&mut replay);
        let retired = take_frame(&mut replay, &mut projection);
        let retired = frame(&retired);
        assert_eq!(retired.rows[0].logical_cell_offset, 0);

        let request = projection.capture_request().unwrap();
        let source = replay
            .capture_viewport_source(std::slice::from_ref(&request), usize::MAX)
            .unwrap()
            .source;
        let geometry = viewport_geometry(&source, 8).unwrap();
        let cold_source = replay
            .history_transfer
            .store()
            .capture_projection_source()
            .unwrap();
        let mut cold_anchor = cold_source
            .resolve_anchor(crate::terminal_replay::cold_history::LogicalCellAnchor {
                logical_line_id: retired.rows[0].logical_line_id,
                logical_cell_offset: retired.rows[0].logical_cell_offset,
            })
            .unwrap_or_else(|_| panic!("cold anchor must resolve"));
        assert_eq!(
            cold_anchor
                .move_rows(64, &geometry)
                .unwrap_or_else(|_| panic!("cold anchor must move")),
            64
        );
        let moved = cold_anchor
            .project_rows(&geometry)
            .unwrap_or_else(|_| panic!("cold anchor must project"));
        let work = moved.work;
        assert_eq!(moved.rows[0].logical_cell_offset, 64 * 1_024);
        assert!(moved.visited_rows <= 12, "{}", moved.visited_rows);
        assert!(
            work.index_nodes_visited >= 24,
            "movement must contribute its native index visits: {work:?}"
        );
        assert!(work.index_nodes_visited <= 128, "{work:?}");
        assert!(work.chunks_visited <= 16, "{work:?}");
        assert!(
            work.cells_visited >= 16 * 1_024,
            "work must include native PAGE decode, clone, and reflow visits: {work:?}"
        );
        assert!(
            work.cells_visited <= 64 * 1_024,
            "bulk movement and projection must not visit every intervening row: {work:?}"
        );

        let resized_geometry = ViewportProjectionGeometry {
            columns: geometry.columns - 1,
            ..geometry
        };
        assert_eq!(
            cold_anchor
                .move_rows(1, &resized_geometry)
                .unwrap_or_else(|_| panic!("cold anchor must move after resize")),
            1
        );
        let resized = cold_anchor
            .project_rows(&resized_geometry)
            .unwrap_or_else(|_| panic!("cold anchor must project after resize"));
        assert_eq!(
            resized.rows[0].logical_cell_offset,
            64 * 1_024 + u32::from(resized_geometry.columns),
            "the stable logical marker is not required to align to resized columns"
        );
        assert!(resized.visited_rows <= 12, "{}", resized.visited_rows);
        assert!(
            resized.work.index_nodes_visited <= 128,
            "{:?}",
            resized.work
        );
        assert!(resized.work.chunks_visited <= 16, "{:?}", resized.work);
    }

    #[cfg(feature = "ghostty-core-proof")]
    #[test]
    fn complex_cold_bulk_move_reports_partial_work_without_claiming_start() {
        let mut replay = TerminalReplay::new(
            SessionFence {
                workspace_id: "workspace".into(),
                session_id: "session".into(),
                runner_principal: "runner".into(),
                runner_instance: "runner-1".into(),
                channel_epoch: 1,
                host_instance_id: "host-1".into(),
                terminal_epoch: "terminal-complex-cold".into(),
            },
            4,
            80,
            TerminalReplayLimits::default(),
        )
        .unwrap();
        for index in 0..100 {
            replay
                .ingest_output(format!("P{index:03}\r\n").as_bytes())
                .unwrap();
        }
        let mut remaining_complex_cells = 43_690_usize;
        while remaining_complex_cells > 0 {
            let chunk = remaining_complex_cells.min(8_000);
            replay.ingest_output("界".repeat(chunk).as_bytes()).unwrap();
            remaining_complex_cells -= chunk;
        }
        let mut projection = replay.attach_view_projection().unwrap();
        configure(&mut replay, &mut projection, 1, 8);
        let initial = take_frame(&mut replay, &mut projection);
        let anchor_row = frame(&initial)
            .rows
            .iter()
            .rev()
            .find(|row| row.logical_cell_offset > 0)
            .expect("complex line must expose an interior wrapped anchor");
        let complex_anchor = crate::terminal_replay::cold_history::LogicalCellAnchor {
            logical_line_id: anchor_row.logical_line_id,
            logical_cell_offset: anchor_row.logical_cell_offset,
        };
        replay.ingest_output(b"\r\n").unwrap();
        for batch_start in (0..5_001).step_by(1_000) {
            let mut output = String::new();
            for index in batch_start..usize::min(batch_start + 1_000, 5_001) {
                output.push_str(&format!("H{index:06}\r\n"));
            }
            replay
                .ingest_output(output.as_bytes())
                .unwrap_or_else(|error| panic!("complex batch {batch_start}: {error:?}"));
        }
        wait_for_cold_storage(&mut replay);
        let cold_source = replay
            .history_transfer
            .store()
            .capture_projection_source()
            .unwrap();
        let cold_anchor = cold_source
            .resolve_anchor(complex_anchor)
            .unwrap_or_else(|_| panic!("complex logical anchor must be cold-owned"));
        projection.follow_tail = false;
        projection.anchor_status = ViewportAnchorStatus::Anchored;
        projection.rows_from_tail = Some(10_000);
        projection.anchor = Some(Box::new(cold_anchor));
        projection.anchor_buffer = Some(BufferId::Normal as i32);

        scroll(&mut replay, &mut projection, 2, 2_048);
        let moved = take_frame(&mut replay, &mut projection);
        let moved = frame(&moved);
        assert_eq!(
            moved.anchor_status,
            ViewportAnchorStatus::Anchored as i32,
            "bounded partial movement must not pretend it reached cold-history start"
        );
        assert!(moved.has_more_before);
        let (visited, work) = projection.projection_work();
        assert!(visited <= 12, "{visited}");
        assert!(work.index_nodes_visited <= 256, "{work:?}");
        assert!(work.chunks_visited <= 32, "{work:?}");
        assert!(work.cells_visited <= 128 * 1024, "{work:?}");
    }

    #[cfg(feature = "ghostty-core-proof")]
    #[test]
    fn ghostty_cold_anchor_survives_distinct_session_checkpoint_rehost_and_reflow() {
        use sha2::{Digest, Sha256};

        let directory = tempfile::tempdir().unwrap();
        let discovery_root = DiscoveryRoot::create(directory.path().join("hmux")).unwrap();
        let discovery = discovery_root
            .session(DiscoveryKey::new("workspace", "session", "runner-source", 1).unwrap())
            .unwrap();
        let source_lock = Arc::new(discovery.acquire_lifetime_lock().unwrap());
        let source_fence = SessionFence {
            workspace_id: "workspace".into(),
            session_id: "session".into(),
            runner_principal: "runner".into(),
            runner_instance: "runner-source".into(),
            channel_epoch: 1,
            host_instance_id: "host-source".into(),
            terminal_epoch: "terminal-cold-source".into(),
        };
        let mut source = TerminalReplay::new_with_cold_history_storage(
            source_fence.clone(),
            4,
            80,
            TerminalReplayLimits::default(),
            discovery
                .cold_history_storage(Arc::clone(&source_lock))
                .unwrap(),
            None,
        )
        .unwrap();
        for batch_start in (0..3_000).step_by(500) {
            let mut output = String::new();
            for index in batch_start..usize::min(batch_start + 500, 3_000) {
                output.push_str(&styled_numbered_line(index));
            }
            source.ingest_output(output.as_bytes()).unwrap();
        }

        let mut source_projection = source.attach_view_projection().unwrap();
        configure(&mut source, &mut source_projection, 1, 8);
        let _tail = take_frame(&mut source, &mut source_projection);
        let mut hot_anchor = None;
        for record_id in 2..=4 {
            scroll(&mut source, &mut source_projection, record_id, 2_048);
            hot_anchor = Some(take_frame(&mut source, &mut source_projection));
        }
        let hot_anchor = protocol_round_trip(hot_anchor.unwrap(), 1);
        let hot_anchor = frame(&hot_anchor);
        assert_numbered_line_style(hot_anchor, 0, "H000000");
        assert_numbered_line_style(hot_anchor, 1, "H000001");
        assert_eq!(
            hot_anchor.rows[0].row_id & crate::terminal_replay::cold_history::COLD_ROW_ID_MASK,
            0,
            "the styled anchor must begin under Ghostty's live hot owner"
        );

        for batch_start in (3_000..5_001).step_by(500) {
            let mut output = String::new();
            for index in batch_start..usize::min(batch_start + 500, 5_001) {
                output.push_str(&styled_numbered_line(index));
            }
            source.ingest_output(output.as_bytes()).unwrap();
        }
        wait_for_cold_storage(&mut source);
        let retired_anchor =
            protocol_round_trip(take_frame(&mut source, &mut source_projection), 2);
        let retired_anchor = frame(&retired_anchor);
        assert_numbered_line_style(retired_anchor, 0, "H000000");
        assert_numbered_line_style(retired_anchor, 1, "H000001");
        assert_ne!(
            retired_anchor.rows[0].row_id & crate::terminal_replay::cold_history::COLD_ROW_ID_MASK,
            0,
            "the exact styled anchor must cross the live-to-cold ownership seam"
        );
        let mut checkpoint = checkpoint_after_cold_storage_settles(&mut source);
        let selected_watermark = checkpoint.cold_history.as_ref().unwrap().root_generation;
        assert!(
            source
                .history_transfer
                .store()
                .capture_projection_source()
                .unwrap()
                .visible_history_state()
                .logical_line_count
                > 0
        );
        for batch_start in (5_001..6_501).step_by(500) {
            let mut output = String::new();
            for index in batch_start..usize::min(batch_start + 500, 6_501) {
                output.push_str(&styled_numbered_line(index));
            }
            source.ingest_output(output.as_bytes()).unwrap();
        }
        wait_for_cold_storage(&mut source);
        let newer_watermark = source
            .history_transfer
            .store()
            .committed_transfer_watermark();
        assert!(
            newer_watermark > selected_watermark,
            "reopen must select the checkpointed root, not a newer cold root"
        );
        drop(source_projection);
        drop(source);
        drop(source_lock);

        let source_cold = checkpoint.cold_history.as_ref().unwrap();
        let source_storage = crate::local_discovery::ColdHistoryStorage::inspect(
            discovery_root.path().to_path_buf(),
            &source_cold.history_namespace,
            &source_cold.store_id,
        )
        .unwrap();
        let source_archive_digest = || {
            let mut digest = Sha256::new();
            digest.update(Sha256::digest(
                source_storage.read_root(64 * 1024).unwrap().unwrap(),
            ));
            let maximum_chunk_bytes =
                TerminalReplayLimits::default().max_history_transfer_offer_bytes + 64 * 1024;
            for transfer_id in 1..=newer_watermark {
                let chunk = source_storage
                    .read_chunk(transfer_id, maximum_chunk_bytes)
                    .unwrap()
                    .unwrap();
                digest.update(transfer_id.to_le_bytes());
                digest.update(Sha256::digest(chunk));
            }
            digest.finalize()
        };
        let source_before_adoption = source_archive_digest();

        // Match the rehost handoff: the successor appends to its own archive,
        // leaving the source's newer published root and immutable chunks intact.
        let adoption = TerminalReplay::adopt_durable_checkpoint(
            discovery_root.path(),
            &checkpoint,
            "rehost-v1-cold-anchor-successor",
            &TerminalReplayLimits::default(),
        )
        .unwrap()
        .unwrap();
        let adopted_cold = adoption.checkpoint();
        assert_ne!(adopted_cold.store_id, source_cold.store_id);
        assert_eq!(
            adopted_cold.history_namespace,
            source_cold.history_namespace
        );
        assert_eq!(adopted_cold.root_generation, selected_watermark);
        checkpoint.cold_history = Some(adopted_cold.clone());
        drop(adoption);

        let successor_discovery = discovery_root
            .session(
                DiscoveryKey::new("workspace", "replacement-session", "runner-successor", 1)
                    .unwrap(),
            )
            .unwrap();
        let successor_fence = SessionFence {
            session_id: "replacement-session".into(),
            runner_instance: "runner-successor".into(),
            host_instance_id: "host-successor".into(),
            terminal_epoch: "terminal-cold-successor".into(),
            ..source_fence.clone()
        };
        let successor_lock = Arc::new(successor_discovery.acquire_lifetime_lock().unwrap());
        let cold_checkpoint = checkpoint.cold_history.as_ref().unwrap();
        let cold_identity = (
            cold_checkpoint.history_namespace.clone(),
            cold_checkpoint.store_id.clone(),
        );
        let root_before_invalid_restore = {
            let storage = successor_discovery
                .cold_history_storage(Arc::clone(&successor_lock))
                .unwrap()
                .bind(&cold_identity.0, &cold_identity.1)
                .unwrap();
            storage.read_root(64 * 1024).unwrap().unwrap()
        };
        let mut invalid_checkpoint = checkpoint.clone();
        invalid_checkpoint.payload = b"invalid native Ghostty checkpoint".to_vec();
        let mut invalid_successor = TerminalReplay::new_with_cold_history_storage(
            successor_fence.clone(),
            4,
            80,
            TerminalReplayLimits::default(),
            successor_discovery
                .cold_history_storage(Arc::clone(&successor_lock))
                .unwrap(),
            Some(&invalid_checkpoint),
        )
        .unwrap();
        assert!(
            invalid_successor
                .restore_checkpoint(
                    crate::local_protocol::RecoveredPresentation {
                        source_fence: source_fence.clone(),
                        sequence_through: invalid_checkpoint.sequence_through,
                        captured_unix_ms: 1,
                        truncated: false,
                    },
                    invalid_checkpoint,
                )
                .is_err(),
            "invalid hot state must abort before sealing the target archive"
        );
        drop(invalid_successor);
        let root_after_invalid_restore = {
            let storage = successor_discovery
                .cold_history_storage(Arc::clone(&successor_lock))
                .unwrap()
                .bind(&cold_identity.0, &cold_identity.1)
                .unwrap();
            storage.read_root(64 * 1024).unwrap().unwrap()
        };
        assert_eq!(
            root_after_invalid_restore, root_before_invalid_restore,
            "failed hot restore must preserve the adopted target root"
        );
        let mut successor = TerminalReplay::new_with_cold_history_storage(
            successor_fence,
            4,
            80,
            TerminalReplayLimits::default(),
            successor_discovery
                .cold_history_storage(Arc::clone(&successor_lock))
                .unwrap(),
            Some(&checkpoint),
        )
        .unwrap();
        successor
            .restore_checkpoint(
                crate::local_protocol::RecoveredPresentation {
                    source_fence,
                    sequence_through: checkpoint.sequence_through,
                    captured_unix_ms: 1,
                    truncated: false,
                },
                checkpoint.clone(),
            )
            .unwrap();
        successor.activate_durable_history().unwrap();

        let mut projection = successor.attach_view_projection().unwrap();
        configure(&mut successor, &mut projection, 1, 8);
        let _tail = take_frame(&mut successor, &mut projection);
        let mut oldest = None;
        for record_id in 2..=4 {
            scroll(&mut successor, &mut projection, record_id, 2_048);
            oldest = Some(take_frame(&mut successor, &mut projection));
        }
        let before = protocol_round_trip(oldest.unwrap(), 3);
        let before = frame(&before);
        assert!(!before.follow_tail);
        assert_eq!(row_text(before, 0), format!("H000000{}", "x".repeat(73)));
        assert_numbered_line_style(before, 0, "H000000");
        assert_numbered_line_style(before, 1, "H000001");
        let logical_anchor = (
            before.rows[0].logical_line_id,
            before.rows[0].logical_cell_offset,
        );

        successor.resize(4, 79).unwrap();
        let after = protocol_round_trip(take_frame(&mut successor, &mut projection), 4);
        let after = frame(&after);
        let (visited, work) = projection.projection_work();
        assert!(visited <= 12);
        assert!(work.index_nodes_visited <= 128, "{work:?}");
        assert!(work.chunks_visited <= 16, "{work:?}");
        assert!(work.cells_visited <= 12 * 1_024, "{work:?}");
        assert!(!after.follow_tail);
        assert_eq!(row_text(after, 0), format!("H000000{}", "x".repeat(72)));
        assert_numbered_line_style(after, 0, "H000000");
        assert_numbered_line_style(after, 2, "H000001");
        assert_eq!(
            (
                after.rows[0].logical_line_id,
                after.rows[0].logical_cell_offset,
            ),
            logical_anchor,
        );
        drop(projection);
        drop(successor);
        let selected_root = successor_discovery
            .cold_history_storage(successor_lock)
            .unwrap()
            .bind(&cold_identity.0, &cold_identity.1)
            .unwrap()
            .read_root(64 * 1024)
            .unwrap()
            .unwrap();
        assert_ne!(
            selected_root, root_before_invalid_restore,
            "successful hot restore must publish the successor's sealed cold root"
        );
        assert_eq!(
            source_archive_digest(),
            source_before_adoption,
            "successor restore and reflow must preserve the source's newer archive"
        );
    }

    #[cfg(feature = "ghostty-core-proof")]
    #[test]
    fn failed_recovered_hot_restore_discards_selected_cold_history_before_attach() {
        let directory = tempfile::tempdir().unwrap();
        let discovery_root = DiscoveryRoot::create(directory.path().join("hmux")).unwrap();
        let source_discovery = discovery_root
            .session(DiscoveryKey::new("workspace", "source", "runner-source", 1).unwrap())
            .unwrap();
        let source_lock = Arc::new(source_discovery.acquire_lifetime_lock().unwrap());
        let source_fence = SessionFence {
            workspace_id: "workspace".into(),
            session_id: "source".into(),
            runner_principal: "runner".into(),
            runner_instance: "runner-source".into(),
            channel_epoch: 1,
            host_instance_id: "host-source".into(),
            terminal_epoch: "terminal-source".into(),
        };
        let limits = TerminalReplayLimits {
            max_checkpoint_bytes: 16 * 1024 * 1024,
            max_pending_history_transfer_bytes: 128 * 1024 * 1024,
            ..TerminalReplayLimits::default()
        };
        let mut source = TerminalReplay::new_with_cold_history_storage(
            source_fence.clone(),
            4,
            80,
            limits.clone(),
            source_discovery
                .cold_history_storage(Arc::clone(&source_lock))
                .unwrap(),
            None,
        )
        .unwrap();
        for batch_start in (0..6_500).step_by(500) {
            let mut output = String::new();
            for index in batch_start..usize::min(batch_start + 500, 6_500) {
                output.push_str(&format!("H{index:06}\r\n"));
            }
            source.ingest_output(output.as_bytes()).unwrap();
        }
        for _ in 0..12 {
            source
                .ingest_output("界".repeat(20_000).as_bytes())
                .unwrap();
        }
        let mut checkpoint = checkpoint_after_cold_storage_settles(&mut source);
        assert!(checkpoint.cold_history.is_some());
        drop(source);
        drop(source_lock);

        let successor_limits = TerminalReplayLimits {
            max_history_transfer_offer_bytes: 512 * 1024,
            ..limits
        };

        let adoption = TerminalReplay::adopt_durable_checkpoint(
            discovery_root.path(),
            &checkpoint,
            "rehost-v1-target",
            &successor_limits,
        )
        .unwrap()
        .expect("the source checkpoint must contain durable cold history");
        checkpoint.cold_history = Some(adoption.checkpoint().clone());
        drop(adoption);

        let successor_discovery = discovery_root
            .session(DiscoveryKey::new("workspace", "successor", "runner-successor", 1).unwrap())
            .unwrap();
        let successor_lock = Arc::new(successor_discovery.acquire_lifetime_lock().unwrap());
        let successor_fence = SessionFence {
            session_id: "successor".into(),
            runner_instance: "runner-successor".into(),
            host_instance_id: "host-successor".into(),
            terminal_epoch: "terminal-successor".into(),
            ..source_fence.clone()
        };
        let mut successor = TerminalReplay::new_with_cold_history_storage(
            successor_fence,
            4,
            80,
            successor_limits,
            successor_discovery
                .cold_history_storage(successor_lock)
                .unwrap(),
            Some(&checkpoint),
        )
        .unwrap();
        let restore_error = successor
            .restore_checkpoint(
                crate::local_protocol::RecoveredPresentation {
                    source_fence,
                    sequence_through: checkpoint.sequence_through,
                    captured_unix_ms: 1,
                    truncated: false,
                },
                checkpoint,
            )
            .unwrap_err();
        assert_eq!(
            restore_error,
            TerminalReplayError::ColdHistoryRetentionRequired
        );
        successor.activate_durable_history().unwrap();
        successor
            .ingest_output(b"SUCCESSOR_OUTPUT_AFTER_RECOVERED_COLD_HISTORY\r\n")
            .unwrap();

        let mut projection = successor.attach_view_projection().unwrap();
        configure(&mut successor, &mut projection, 1, 4);
        let initial = take_frame(&mut successor, &mut projection);
        assert!(
            (0..frame(&initial).rows.len())
                .any(|row| row_text(frame(&initial), row).contains("SUCCESSOR_OUTPUT"))
        );
    }

    #[cfg(feature = "ghostty-core-proof")]
    #[test]
    fn durable_reopen_enforces_aggregate_bytes_before_a_later_missing_chunk() {
        let directory = tempfile::tempdir().unwrap();
        let discovery_root = DiscoveryRoot::create(directory.path().join("hmux")).unwrap();
        let discovery = discovery_root
            .session(DiscoveryKey::new("workspace", "source", "runner-source", 1).unwrap())
            .unwrap();
        let source_lock = Arc::new(discovery.acquire_lifetime_lock().unwrap());
        let source_fence = SessionFence {
            workspace_id: "workspace".into(),
            session_id: "source".into(),
            runner_principal: "runner".into(),
            runner_instance: "runner-source".into(),
            channel_epoch: 1,
            host_instance_id: "host-source".into(),
            terminal_epoch: "terminal-source".into(),
        };
        let mut source = TerminalReplay::new_with_cold_history_storage(
            source_fence.clone(),
            4,
            80,
            TerminalReplayLimits::default(),
            discovery
                .cold_history_storage(Arc::clone(&source_lock))
                .unwrap(),
            None,
        )
        .unwrap();
        for batch_start in (0..6_500).step_by(500) {
            let mut output = String::new();
            for index in batch_start..usize::min(batch_start + 500, 6_500) {
                output.push_str(&format!("H{index:06}\r\n"));
            }
            source.ingest_output(output.as_bytes()).unwrap();
        }
        let checkpoint = checkpoint_after_cold_storage_settles(&mut source);
        let watermark = checkpoint
            .cold_history
            .as_ref()
            .expect("fixture must publish durable cold history")
            .root_generation;
        assert!(watermark >= 2, "fixture needs multiple durable chunks");
        drop(source);
        drop(source_lock);

        let history_root = discovery_root.path().join(".terminal-history-v2");
        let store = std::fs::read_dir(&history_root)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .find(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("h_"))
            })
            .expect("one cold history store");
        std::fs::remove_file(store.join(format!("chunk-{watermark:020}.bin"))).unwrap();

        let successor = discovery_root
            .session(DiscoveryKey::new("workspace", "target", "runner-target", 1).unwrap())
            .unwrap();
        let successor_lock = Arc::new(successor.acquire_lifetime_lock().unwrap());
        let result = TerminalReplay::new_with_cold_history_storage(
            SessionFence {
                session_id: "target".into(),
                runner_instance: "runner-target".into(),
                host_instance_id: "host-target".into(),
                terminal_epoch: "terminal-target".into(),
                ..source_fence
            },
            4,
            80,
            TerminalReplayLimits {
                max_cold_history_bytes: 1,
                ..TerminalReplayLimits::default()
            },
            successor.cold_history_storage(successor_lock).unwrap(),
            Some(&checkpoint),
        );
        let error = match result {
            Ok(_) => panic!("aggregate cold history bytes must reject reopen"),
            Err(error) => error,
        };
        assert_eq!(error, TerminalReplayError::ColdHistoryRetentionRequired);
    }

    #[test]
    fn undrained_resizes_publish_only_the_latest_complete_frame() {
        let mut replay = replay();
        populate(&mut replay, "resize", 10);
        let mut projection = replay.attach_view_projection().unwrap();
        let canonical_before = replay.terminal.size();
        configure(&mut replay, &mut projection, 1, 3);
        assert_eq!(replay.terminal.size(), canonical_before);
        let _initial = take_frame(&mut replay, &mut projection);

        replay.resize(4, 18).unwrap();
        replay.resize(4, 12).unwrap();
        replay.resize(4, 16).unwrap();
        let latest = take_frame(&mut replay, &mut projection);

        assert_eq!(frame(&latest).canonical_columns, 16);
        assert_eq!(frame(&latest).projection_revision, 2);
        assert_eq!(frame(&latest).damage_base_projection_revision, 0);
        assert!(
            replay
                .take_latest_viewport_frame(&mut projection)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn detach_drops_the_ephemeral_projection() {
        let mut replay = replay();
        populate(&mut replay, "detach", 10);
        let mut projection = replay.attach_view_projection().unwrap();
        configure(&mut replay, &mut projection, 1, 3);
        let _ = take_frame(&mut replay, &mut projection);
        scroll(&mut replay, &mut projection, 2, 2);
        let _ = take_frame(&mut replay, &mut projection);

        replay.detach_view_projection(&mut projection).unwrap();

        assert!(!projection.is_attached());
        assert!(replay.take_latest_viewport_frame(&mut projection).is_err());
        let input = ingress(
            &replay,
            3,
            projection.projection_revision,
            viewport_intent::Intent::SetViewportRows(SetViewportRows { rows: 4 }),
        );
        assert!(
            replay
                .apply_viewport_intent(&mut projection, &input)
                .is_err()
        );

        let mut fresh = replay.attach_view_projection().unwrap();
        assert!(replay.apply_viewport_intent(&mut fresh, &input).is_err());
        configure(&mut replay, &mut fresh, 1, 4);
        assert_eq!(
            frame(&take_frame(&mut replay, &mut fresh)).applied_intent_seq,
            1
        );
    }

    #[test]
    fn a_projection_is_bound_to_its_origin_replay_even_with_the_same_fence() {
        let mut first = replay();
        let mut second = replay();
        let mut foreign = first.attach_view_projection().unwrap();
        let input = ingress(
            &second,
            1,
            0,
            viewport_intent::Intent::SetViewportRows(SetViewportRows { rows: 4 }),
        );

        assert!(second.apply_viewport_intent(&mut foreign, &input).is_err());
        assert!(second.take_latest_viewport_frame(&mut foreign).is_err());
        assert!(second.detach_view_projection(&mut foreign).is_err());
    }

    #[test]
    fn no_op_and_clamped_intents_are_acknowledged_by_complete_frames() {
        let mut replay = replay();
        populate(&mut replay, "ack", 12);
        let mut projection = replay.attach_view_projection().unwrap();
        configure(&mut replay, &mut projection, 1, 3);
        let initial = take_frame(&mut replay, &mut projection);

        let no_op = ingress(
            &replay,
            2,
            frame(&initial).projection_revision,
            viewport_intent::Intent::SetViewportRows(SetViewportRows { rows: 3 }),
        );
        assert_eq!(
            replay
                .apply_viewport_intent(&mut projection, &no_op)
                .unwrap(),
            ViewportIntentDisposition::NoChange,
        );
        let no_op_ack = take_frame(&mut replay, &mut projection);
        assert_eq!(frame(&no_op_ack).applied_intent_seq, 2);
        assert_eq!(frame(&no_op_ack).projection_revision, 2);

        scroll(&mut replay, &mut projection, 3, 2_048);
        let clamped = take_frame(&mut replay, &mut projection);
        assert_eq!(frame(&clamped).applied_intent_seq, 3);
        assert_eq!(
            frame(&clamped).anchor_status,
            ViewportAnchorStatus::ClampedStart as i32,
        );

        let at_start = ingress(
            &replay,
            4,
            frame(&clamped).projection_revision,
            viewport_intent::Intent::ScrollRows(ScrollRows { rows: 2_048 }),
        );
        assert_eq!(
            replay
                .apply_viewport_intent(&mut projection, &at_start)
                .unwrap(),
            ViewportIntentDisposition::NoChange,
        );
        let clamped_ack = take_frame(&mut replay, &mut projection);
        assert_eq!(frame(&clamped_ack).applied_intent_seq, 4);
        assert_eq!(frame(&clamped_ack).projection_revision, 4);
    }

    #[test]
    fn ordered_scroll_deltas_fold_into_the_latest_acknowledged_frame() {
        let mut replay = replay();
        populate(&mut replay, "fold", 20);
        let mut projection = replay.attach_view_projection().unwrap();
        configure(&mut replay, &mut projection, 1, 3);
        let initial = take_frame(&mut replay, &mut projection);

        scroll(&mut replay, &mut projection, 2, 2);
        scroll(&mut replay, &mut projection, 3, 2);
        let folded = take_frame(&mut replay, &mut projection);

        assert_eq!(frame(&folded).projection_revision, 2);
        assert_eq!(frame(&folded).applied_intent_seq, 3);
        assert_eq!(frame(&folded).rows_from_tail, Some(4));
        assert_ne!(row_text(frame(&initial), 0), row_text(frame(&folded), 0));
    }

    #[test]
    fn viewport_colors_preserve_semantic_defaults_and_terminal_overrides() {
        let mut replay = replay();
        replay.ingest_output(b"default\r\n").unwrap();
        let mut projection = replay.attach_view_projection().unwrap();
        configure(&mut replay, &mut projection, 1, 3);
        let themed_by_surface = take_frame(&mut replay, &mut projection);
        let themed_by_surface = frame(&themed_by_surface);
        let overrides = themed_by_surface.color_overrides.as_ref().unwrap();
        assert!(overrides.indexed.is_empty());
        assert_eq!(overrides.default_foreground_rgb, None);
        assert_eq!(overrides.default_background_rgb, None);
        assert_eq!(overrides.cursor_rgb, None);
        assert!(
            themed_by_surface
                .tables
                .as_ref()
                .unwrap()
                .styles
                .iter()
                .all(|style| style.foreground.is_none() && style.background.is_none())
        );

        replay
            .ingest_output(
                b"\x1b]4;5;rgb:12/34/56\x1b\\\x1b]10;rgb:ab/cd/ef\x1b\\\
                  \x1b]11;rgb:01/02/03\x1b\\\x1b]12;rgb:04/05/06\x1b\\",
            )
            .unwrap();
        let terminal_override = take_frame(&mut replay, &mut projection);
        let overrides = frame(&terminal_override).color_overrides.as_ref().unwrap();

        assert_eq!(overrides.indexed.len(), 1);
        assert_eq!(overrides.indexed[0].index, 5);
        assert_eq!(overrides.indexed[0].rgb, 0x123456);
        assert_eq!(overrides.default_foreground_rgb, Some(0xabcdef));
        assert_eq!(overrides.default_background_rgb, Some(0x010203));
        assert_eq!(overrides.cursor_rgb, Some(0x040506));
    }
}
