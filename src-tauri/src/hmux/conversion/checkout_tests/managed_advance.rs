use super::*;

fn replacement_generation_is_dead(descriptor: &SessionDescriptor) -> bool {
    use hmux_client::{probe_local_process_generation, LocalProcessGenerationStatus};
    probe_local_process_generation(&descriptor.host_process).unwrap()
        == LocalProcessGenerationStatus::Absent
        && probe_local_process_generation(&descriptor.provider_process).unwrap()
            == LocalProcessGenerationStatus::Absent
}

pub(super) fn assert_replacement_handoff(
    manager: &HmuxManager,
    app: &AppHandle<tauri::test::MockRuntime>,
    current: &runtime::InstalledBuild,
    request: &SessionConversionRequest,
    source: &SessionDescriptor,
    source_key: &str,
) {
    let catalog = product_catalog().unwrap();
    let target = create_pending_replacement(manager, current, request, source);
    let target_key = conversion_replacement_idempotency_key(&request.conversion_id, 0);
    let descriptor = catalog
        .find(&SessionSelector::new(
            &target.session_id,
            Some(target.workspace_id.clone()),
        ))
        .unwrap();
    let registration = capture_git_checkout_registration(Path::new(&request.cwd))
        .unwrap()
        .unwrap();
    let retained = read_git_checkout_claims(&registration).unwrap();
    assert_eq!(retained.len(), 1);
    // Retire this generation without closing its logical create. This is the
    // converter's existing advance case, not intentional session deletion.
    ManagedSessionStopper::new(&current.runtime, current.runtime.parent().unwrap())
        .stop(managed_stop_request_for_descriptor("retire-first-replacement", &descriptor).unwrap())
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(8);
    while !replacement_generation_is_dead(&descriptor) && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(50));
    }
    assert!(replacement_generation_is_dead(&descriptor));
    let mut retry = request.clone();
    retry.expected_conversation_id = None;
    let result = manager.convert_session(app, retry.clone());
    let advanced = matches!(&result, Ok(receipt)
        if receipt.outcome == "converted"
            && receipt.replacement_session.as_ref().is_some_and(|next| next.session_id != target.session_id));
    let inherited = read_git_checkout_claims(&registration).unwrap() == retained;
    if let Ok(receipt) = &result {
        if let Some(next) = &receipt.replacement_session {
            let bindings = crate::session_credentials::credential_session_bindings(
                request.provider_id.clone(),
            )
            .unwrap();
            let attributed = bindings
                .iter()
                .find(|binding| binding.session_id == next.session_id)
                .expect("the actual successor owns its credential attribution");
            assert_eq!(
                Some(&attributed.launch_id),
                receipt.replacement_idempotency_key.as_ref()
            );
            assert_eq!(attributed.workspace_id, next.workspace_id);
            assert_eq!(
                Some(&attributed.conversation_id),
                receipt.conversation_id.as_ref()
            );
            assert_eq!(attributed.credential_id, request.credential_id);
            let replay = manager.convert_session(app, retry).unwrap();
            assert_eq!(replay.outcome, "converted");
            assert!(replay.replayed);
            assert_eq!(
                replay.replacement_idempotency_key,
                receipt.replacement_idempotency_key
            );
            let replayed = replay.replacement_session.unwrap();
            assert_eq!(replayed.session_id, next.session_id);
            assert_eq!(replayed.workspace_id, next.workspace_id);
            assert_eq!(replayed.terminal_epoch, next.terminal_epoch);
            assert_eq!(replayed.stop_fence, next.stop_fence);
            assert_eq!(
                crate::session_credentials::credential_session_bindings(
                    request.provider_id.clone()
                )
                .unwrap(),
                bindings,
            );
            manager
                .stop_managed_create_chain_v2(
                    app,
                    receipt.replacement_idempotency_key.as_deref().unwrap(),
                    &next.session_id,
                    &next.workspace_id,
                )
                .unwrap();
        }
    }
    let released_by_target = read_git_checkout_claims(&registration).unwrap().is_empty();
    // Capture target ownership and cleanup before closing the previous attempt
    // or source, so those fallback fixture cleanups cannot hide a leaked claim.
    manager
        .stop_managed_create_chain_v2(app, &target_key, &target.session_id, &target.workspace_id)
        .unwrap();
    manager
        .stop_managed_create_chain_v2(app, source_key, &source.session_id, &source.workspace_id)
        .unwrap();
    assert_eq!(
        (advanced, inherited, released_by_target),
        (true, true, true),
        "replacement advance lost checkout handoff: {result:?}",
    );
}
