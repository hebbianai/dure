use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};

use hmux_host::local_protocol::OperationReceiptReason;
use hmux_host::terminal_replay::{ViewProjection, ViewportIntentApplication, WheelPtySink};
use terminal_state_protocol::DecodedRecord;

use crate::host_resource_budget::RetainedActiveConnection;
use crate::input_transaction::input_operation_reason;
use crate::terminal_geometry::TerminalSurfaceGeometry;

use super::super::{Result, ServerState, lock};
use super::publication::{AttachmentViewportProjection, ViewportProjectionPublication};

/// Serializes an attachment mutation with the publication generation that
/// makes it observable. Provider exit takes the same actor lock before sealing
/// its final generation, so it either seals first and refuses this mutation or
/// observes the generation advanced before this guard is released.
pub(crate) struct TerminalSurfaceMutation<'a> {
    actor: MutexGuard<'a, TerminalSurfaceActor>,
    publication: &'a ViewportProjectionPublication,
}

impl<'a> TerminalSurfaceMutation<'a> {
    pub(crate) fn begin(
        actor: &'a Mutex<TerminalSurfaceActor>,
        publication: &'a ViewportProjectionPublication,
    ) -> Result<Self> {
        let actor = lock(actor)?;
        if publication.current_generation().is_none() {
            return Err("terminal viewport publication is no longer available".into());
        }
        Ok(Self { actor, publication })
    }

    pub(crate) fn actor_mut(&mut self) -> &mut TerminalSurfaceActor {
        &mut self.actor
    }

    pub(crate) fn publish(&self) -> Result<()> {
        if !self.publication.mark_dirty() {
            return Err("terminal viewport publication is no longer available".into());
        }
        Ok(())
    }

    fn install_frame_receipt_barrier(
        &mut self,
        client_id: u64,
        receipt_barrier: Option<String>,
    ) -> Result<bool> {
        let Some(receipt_barrier) = receipt_barrier else {
            return Ok(false);
        };
        let projection_registered = self
            .actor
            .surfaces
            .get(&client_id)
            .is_some_and(|surface| surface.projection.is_some());
        if !projection_registered {
            return Ok(false);
        }
        self.publish()?;
        let surface = self
            .actor
            .surfaces
            .get_mut(&client_id)
            .expect("the mutation fence keeps the terminal surface current");
        surface.frame_receipt_barrier = Some(receipt_barrier);
        surface.publication_blocked.store(true, Ordering::Release);
        Ok(true)
    }
}

pub(crate) struct TerminalSurfaceState {
    pub(crate) geometry: Option<TerminalSurfaceGeometry>,
    pub(crate) geometry_generation: u64,
    pub(crate) projection: Option<Arc<AttachmentViewportProjection>>,
    pub(crate) wheel_pty_sink: WheelPtySink,
    pub(crate) frame_receipt_barrier: Option<String>,
    pub(crate) publication_blocked: Arc<AtomicBool>,
    pub(crate) publication_revision: Arc<AtomicU64>,
}

impl Default for TerminalSurfaceState {
    fn default() -> Self {
        Self {
            geometry: None,
            geometry_generation: 0,
            projection: None,
            wheel_pty_sink: WheelPtySink::Absent,
            frame_receipt_barrier: None,
            publication_blocked: Arc::new(AtomicBool::new(false)),
            publication_revision: Arc::new(AtomicU64::new(0)),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum TerminalSurfaceProposalError {
    StaleGeometryGeneration,
    Operation(OperationReceiptReason),
}

impl TerminalSurfaceProposalError {
    pub(crate) fn operation_reason(self) -> OperationReceiptReason {
        match self {
            Self::StaleGeometryGeneration => OperationReceiptReason::StaleControllerGeneration,
            Self::Operation(reason) => reason,
        }
    }
}

impl From<OperationReceiptReason> for TerminalSurfaceProposalError {
    fn from(reason: OperationReceiptReason) -> Self {
        Self::Operation(reason)
    }
}

#[derive(Default)]
pub(crate) struct TerminalSurfaceActor {
    pub(crate) surfaces: HashMap<u64, TerminalSurfaceState>,
}

impl TerminalSurfaceActor {
    pub(crate) fn selected_geometry(&self) -> Option<TerminalSurfaceGeometry> {
        self.surfaces
            .values()
            .filter_map(|surface| surface.geometry)
            .reduce(TerminalSurfaceGeometry::fit_surfaces)
    }

    pub(crate) fn selected_geometry_with(
        &self,
        client_id: u64,
        proposed: TerminalSurfaceGeometry,
    ) -> TerminalSurfaceGeometry {
        self.surfaces
            .iter()
            .filter_map(|(candidate_id, surface)| {
                (*candidate_id != client_id)
                    .then_some(surface.geometry)
                    .flatten()
            })
            .fold(proposed, TerminalSurfaceGeometry::fit_surfaces)
    }
}

impl ServerState {
    pub(crate) fn propose_terminal_surface(
        &self,
        client_id: u64,
        rows: u16,
        columns: u16,
        geometry_generation: Option<u64>,
        frame_receipt_barrier: Option<String>,
    ) -> std::result::Result<TerminalSurfaceGeometry, TerminalSurfaceProposalError> {
        if rows == 0 || columns == 0 {
            return Err(OperationReceiptReason::InvalidTerminalDimensions.into());
        }
        if self.provider_exit_observed.load(Ordering::Acquire) {
            return Err(TerminalSurfaceProposalError::Operation(
                OperationReceiptReason::HostExiting,
            ));
        }
        let mut mutation =
            TerminalSurfaceMutation::begin(&self.terminal_surfaces, &self.viewport_publication)
                .map_err(|_| {
                    TerminalSurfaceProposalError::Operation(OperationReceiptReason::HostExiting)
                })?;
        let surface = mutation.actor_mut().surfaces.entry(client_id).or_default();
        if let Some(generation) = geometry_generation {
            if generation <= surface.geometry_generation {
                return Err(TerminalSurfaceProposalError::StaleGeometryGeneration);
            }
            // A generation names one exact external resize attempt, not only a
            // successful geometry. Consume it before crossing the platform
            // boundary so a nonretryable failure cannot execute twice. The
            // last applied geometry remains separate and usable until a newer
            // generation succeeds.
            surface.geometry_generation = generation;
        }
        let receipt_blocked = mutation
            .install_frame_receipt_barrier(client_id, frame_receipt_barrier)
            .map_err(|_| {
                TerminalSurfaceProposalError::Operation(OperationReceiptReason::ResourceLimit)
            })?;
        let proposed = TerminalSurfaceGeometry { rows, columns };
        let selected = mutation
            .actor_mut()
            .selected_geometry_with(client_id, proposed);
        let current = self
            .host
            .lock()
            .map_err(|_| {
                TerminalSurfaceProposalError::Operation(OperationReceiptReason::ResourceLimit)
            })?
            .current_dimensions();
        let canonical_changed = current != (selected.rows, selected.columns);
        if canonical_changed {
            self.resize_terminal_with_admission(None, selected.rows, selected.columns)?;
            if let Some(surface) = mutation.actor_mut().surfaces.get(&client_id) {
                if surface.projection.is_some() {
                    advance_publication_revision(surface)?;
                }
            }
        }
        let surface = mutation
            .actor_mut()
            .surfaces
            .get_mut(&client_id)
            .expect("the terminal surface generation remains owned by this mutation");
        surface.geometry = Some(proposed);
        let projection_changed = if let Some(projection) = surface.projection.as_ref() {
            let mut host = self.host.lock().map_err(|_| {
                TerminalSurfaceProposalError::Operation(OperationReceiptReason::ResourceLimit)
            })?;
            let publication_revision = Arc::clone(&surface.publication_revision);
            projection
                .with_projection(|projection| {
                    let changed = host
                        .set_view_projection_rows(&self.fence, projection, rows)
                        .map_err(|error| input_operation_reason(&error))
                        .map_err(TerminalSurfaceProposalError::Operation)?;
                    if changed && !canonical_changed {
                        publication_revision
                            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |revision| {
                                revision.checked_add(1)
                            })
                            .map_err(|_| {
                                TerminalSurfaceProposalError::Operation(
                                    OperationReceiptReason::ResourceLimit,
                                )
                            })?;
                    }
                    Ok::<_, TerminalSurfaceProposalError>(changed)
                })
                .ok_or(TerminalSurfaceProposalError::Operation(
                    OperationReceiptReason::ResourceLimit,
                ))??
        } else {
            false
        };
        if projection_changed && !canonical_changed && !receipt_blocked {
            mutation.publish().map_err(|_| {
                TerminalSurfaceProposalError::Operation(OperationReceiptReason::ResourceLimit)
            })?;
        }
        Ok(selected)
    }

    pub(crate) fn release_terminal_surface_frame(
        &self,
        client_id: u64,
        receipt_barrier: &str,
    ) -> Result<()> {
        let mut mutation =
            TerminalSurfaceMutation::begin(&self.terminal_surfaces, &self.viewport_publication)?;
        {
            let Some(surface) = mutation.actor_mut().surfaces.get_mut(&client_id) else {
                return Err("terminal surface is no longer current".into());
            };
            match surface.frame_receipt_barrier.as_deref() {
                None => return Ok(()),
                Some(current) if current != receipt_barrier => {
                    return Err("terminal surface frame receipt barrier is stale".into());
                }
                Some(_) => {
                    surface.frame_receipt_barrier = None;
                    surface.publication_blocked.store(false, Ordering::Release);
                }
            }
        }
        mutation.publish()
    }

    pub(crate) fn register_seeded_terminal_view_projection(
        self: &Arc<Self>,
        client_id: u64,
        projection: ViewProjection,
        seeded_publication_generation: u64,
        wheel_pty_sink: WheelPtySink,
        active_connection: RetainedActiveConnection,
    ) -> Result<()> {
        let mut mutation =
            TerminalSurfaceMutation::begin(&self.terminal_surfaces, &self.viewport_publication)?;
        let projection = {
            let surface = mutation.actor_mut().surfaces.entry(client_id).or_default();
            if surface.projection.is_some() {
                return Err("terminal surface projection was registered twice".into());
            }
            let projection = AttachmentViewportProjection::new(projection);
            // The synchronous attach seed has already completed this generation.
            projection.mark_completed(seeded_publication_generation);
            surface.projection = Some(Arc::clone(&projection));
            surface.wheel_pty_sink = wheel_pty_sink;
            projection
        };
        if self.viewport_publication.current_generation() != Some(seeded_publication_generation) {
            mutation.publish()?;
        }
        drop(mutation);
        self.spawn_attachment_projection_worker(client_id, projection, active_connection);
        Ok(())
    }

    pub(crate) fn apply_terminal_viewport_intent(
        &self,
        client_id: u64,
        ingress: &DecodedRecord,
        frame_receipt_barrier: Option<String>,
    ) -> Result<ViewportIntentApplication> {
        if self.provider_exit_observed.load(Ordering::Acquire) {
            return Err("terminal viewport attachment is exiting".into());
        }
        let mut mutation =
            TerminalSurfaceMutation::begin(&self.terminal_surfaces, &self.viewport_publication)?;
        let (wheel_pty_sink, projection, publication_revision) = {
            let surface = mutation
                .actor_mut()
                .surfaces
                .get(&client_id)
                .ok_or("terminal viewport attachment is no longer current")?;
            (
                surface.wheel_pty_sink,
                surface
                    .projection
                    .as_ref()
                    .cloned()
                    .ok_or("terminal viewport attachment has no projection")?,
                Arc::clone(&surface.publication_revision),
            )
        };
        let mut host = lock(&self.host)?;
        let application = projection
            .with_projection(|projection| {
                let application =
                    host.route_viewport_intent(&self.fence, projection, ingress, wheel_pty_sink)?;
                publication_revision
                    .fetch_update(Ordering::AcqRel, Ordering::Acquire, |revision| {
                        revision.checked_add(1)
                    })
                    .map_err(|_| "terminal surface publication revision exhausted")?;
                Ok::<_, Box<dyn std::error::Error + Send + Sync>>(application)
            })
            .ok_or("terminal viewport projection is unavailable")??;
        drop(host);
        let receipt_blocked =
            mutation.install_frame_receipt_barrier(client_id, frame_receipt_barrier)?;
        if !receipt_blocked {
            mutation.publish()?;
        }
        Ok(application)
    }

    pub(crate) fn remove_terminal_surface(&self, client_id: u64) {
        let Ok(mut actor) = self.terminal_surfaces.lock() else {
            return;
        };
        let publication_open = self.viewport_publication.current_generation().is_some()
            && !self.provider_exit_observed.load(Ordering::Acquire);
        let Some(mut removed) = actor.surfaces.remove(&client_id) else {
            return;
        };
        removed
            .publication_revision
            .store(u64::MAX, Ordering::Release);
        removed.publication_blocked.store(true, Ordering::Release);
        let selected = actor.selected_geometry();
        if let Some(projection) = removed.projection.take() {
            projection.close();
            if let Ok(mut host) = self.host.lock() {
                let _ = projection.with_projection(|projection| {
                    host.detach_view_projection(&self.fence, projection)
                });
            }
        }
        let Some(selected) = selected else {
            return;
        };
        if !publication_open {
            return;
        }
        let current = self.host.lock().ok().map(|host| host.current_dimensions());
        if current != Some((selected.rows, selected.columns)) {
            let _ = self.resize_terminal_with_admission(None, selected.rows, selected.columns);
        }
    }
}

fn advance_publication_revision(
    surface: &TerminalSurfaceState,
) -> std::result::Result<(), TerminalSurfaceProposalError> {
    surface
        .publication_revision
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |revision| {
            revision.checked_add(1)
        })
        .map(|_| ())
        .map_err(|_| TerminalSurfaceProposalError::Operation(OperationReceiptReason::ResourceLimit))
}

#[cfg(test)]
mod tests {
    use super::*;
    use hmux_host::local_protocol::SessionFence;
    use hmux_host::terminal_replay::{TerminalReplay, TerminalReplayLimits};

    fn surface(rows: u16, columns: u16) -> TerminalSurfaceState {
        TerminalSurfaceState {
            geometry: Some(TerminalSurfaceGeometry { rows, columns }),
            geometry_generation: 0,
            projection: None,
            wheel_pty_sink: WheelPtySink::Absent,
            frame_receipt_barrier: None,
            publication_blocked: Arc::new(AtomicBool::new(false)),
            publication_revision: Arc::new(AtomicU64::new(0)),
        }
    }

    #[test]
    fn canonical_geometry_fits_the_narrowest_live_surface() {
        let actor = TerminalSurfaceActor {
            surfaces: HashMap::from([(1, surface(10, 200)), (2, surface(40, 80))]),
        };

        assert_eq!(
            actor.selected_geometry(),
            Some(TerminalSurfaceGeometry {
                rows: 40,
                columns: 80,
            })
        );
        assert_eq!(
            actor.selected_geometry_with(
                2,
                TerminalSurfaceGeometry {
                    rows: 30,
                    columns: 120
                }
            ),
            TerminalSurfaceGeometry {
                rows: 30,
                columns: 120
            },
        );
    }

    #[test]
    fn receipt_barrier_reserves_a_generation_before_later_work_can_fail() {
        let mut replay = TerminalReplay::new(
            SessionFence {
                workspace_id: "workspace".into(),
                session_id: "session".into(),
                runner_principal: "runner".into(),
                runner_instance: "runner-1".into(),
                channel_epoch: 1,
                host_instance_id: "host-1".into(),
                terminal_epoch: "receipt-barrier-generation".into(),
            },
            24,
            80,
            TerminalReplayLimits::default(),
        )
        .unwrap();
        let mut state = surface(24, 80);
        state.projection = Some(AttachmentViewportProjection::new(
            replay.attach_view_projection().unwrap(),
        ));
        let actor = Mutex::new(TerminalSurfaceActor {
            surfaces: HashMap::from([(7, state)]),
        });
        let publication = ViewportProjectionPublication::new();

        let mut mutation = TerminalSurfaceMutation::begin(&actor, &publication).unwrap();
        assert!(
            mutation
                .install_frame_receipt_barrier(7, Some("receipt-7".into()))
                .unwrap()
        );
        drop(mutation);

        assert_eq!(publication.current_generation(), Some(1));
        let actor = actor.lock().unwrap();
        let surface = actor.surfaces.get(&7).unwrap();
        assert_eq!(surface.frame_receipt_barrier.as_deref(), Some("receipt-7"));
        assert!(surface.publication_blocked.load(Ordering::Acquire));
    }
}
