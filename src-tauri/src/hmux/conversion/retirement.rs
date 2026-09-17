use super::*;

pub(super) fn finish(
    catalog: &LocalSessionCatalog,
    runtime: &std::path::Path,
    request: &SessionConversionRequest,
    source: Option<&SessionDescriptor>,
    checkpoint: &recovery::RecoveryResumeCheckpoint,
) -> Result<(), String> {
    let Some(fence) = &request.expected_source_fence else {
        return match source {
            Some(source) => stop_standalone_source(catalog, source, checkpoint),
            None => Ok(()),
        };
    };
    // The prepared request owns the approved generation. Replays do not need
    // a surviving manifest or a client-supplied create key to finish retirement.
    let channel_epoch = fence
        .channel_epoch
        .parse::<u64>()
        .map_err(|_| "managed stop channel epoch is invalid".to_string())?;
    let stop = ManagedStopRequest::new(
        format!("{}_stop", request.conversion_id),
        &request.source_session_id,
        &request.source_workspace_id,
    )
    .and_then(|stop| {
        stop.with_expected_fence(
            &fence.runner_principal,
            &fence.runner_instance,
            channel_epoch,
            &fence.host_instance_id,
            &fence.terminal_epoch,
        )
    })
    .map_err(|error| error.to_string())?;
    let working_directory = runtime
        .parent()
        .ok_or_else(|| "managed Hmux runtime has no parent directory".to_string())?;
    ManagedSessionStopper::new(runtime, working_directory)
        .stop_and_close_creation(stop)
        .map(|_| ())
        .map_err(|error| format!("{}: {error}", error.code()))
}

pub(super) fn stop_standalone_source(
    catalog: &LocalSessionCatalog,
    source: &SessionDescriptor,
    checkpoint: &recovery::RecoveryResumeCheckpoint,
) -> Result<(), String> {
    let exact = catalog
        .open(&SessionSelector::new(
            &source.session_id,
            Some(source.workspace_id.clone()),
        ))
        .map_err(|error| error.to_string())?;
    if !source_fence_matches(checkpoint, exact.descriptor()) {
        return Err(
            "session_conversion_source_fence_changed: standalone generation changed before stop"
                .to_string(),
        );
    }
    exact
        .terminate_standalone(catalog, Duration::from_secs(3))
        .map_err(|error| error.to_string())
}
