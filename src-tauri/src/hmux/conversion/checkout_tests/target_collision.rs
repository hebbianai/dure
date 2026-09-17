use super::*;

pub(super) fn assert_unowned_target_is_not_adopted(
    manager: &HmuxManager,
    app: &AppHandle<tauri::test::MockRuntime>,
    current: &runtime::InstalledBuild,
    request: &SessionConversionRequest,
    source: &SessionDescriptor,
    source_key: &str,
    same_standalone_id: bool,
) {
    let catalog = product_catalog().unwrap();
    let command =
        exact_adoption_resume_command("codex", CONVERSATION, request.permission_mode).unwrap();
    let argv = vec!["/bin/sh".into(), "-lc".into(), format!("exec {command}")];
    let unrelated = match request.target {
        SessionConversionTarget::Standalone => {
            let create = if same_standalone_id {
                launch::standalone_request(
                    request,
                    argv,
                    0,
                    "unrelated-private-create-proof".into(),
                )
                .unwrap()
            } else {
                StandaloneCreateRequest::new(
                    &request.cwd,
                    Some(conversion_standalone_name(
                        &source.session_id,
                        request.target,
                        0,
                    )),
                    argv,
                    request.rows,
                    request.columns,
                )
                .unwrap()
            };
            let created = StandaloneSessionCreator::new(&current.runtime)
                .with_discovery_root(catalog.discovery_root())
                .create(create.clone())
                .unwrap();
            if same_standalone_id {
                assert_eq!(
                    created.session().descriptor().session_id,
                    create.recovery_identity().unwrap().target_session_id(),
                );
            }
            created.session().clone()
        }
        SessionConversionTarget::Managed => {
            let create = ManagedCreateRequest::new(
                "unrelated-conversion-target",
                conversion_target_session_id(&source.session_id, request.target, 0),
                &source.workspace_id,
                &request.provider_id,
                request.permission_mode,
                &request.cwd,
                argv,
                request.rows,
                request.columns,
            )
            .unwrap()
            .with_conversation_identity(
                ProviderConversationIdentitySeed::new("codex", CONVERSATION).unwrap(),
            )
            .unwrap();
            ManagedSessionCreator::new(&current.runtime)
                .create(require_conversation_fenced_managed_stop_lifecycle(create).unwrap())
                .unwrap()
                .session()
                .clone()
        }
    };
    // Make the unrelated target match even the real provider/cwd observation;
    // only its creation identity distinguishes it from this conversion.
    let expected = inspect_source_provider(source, request, Path::new(&request.cwd)).unwrap();
    verify_replacement(
        &catalog,
        unrelated.descriptor().clone(),
        request,
        &current.build_id,
        &expected,
    )
    .unwrap();
    let result = manager.convert_session(app, request.clone());
    let refused = matches!(&result, Err(reason)
        if reason.starts_with("session_conversion_replacement_conflict:"));
    let observed = catalog
        .find(&SessionSelector::new(
            &source.session_id,
            Some(source.workspace_id.clone()),
        ))
        .unwrap();
    let source_preserved = observed.lifecycle == SessionLifecycle::Ready
        && process_generation_is_live(&observed.provider_process);
    // Capture both observations before retiring only this fixture's sessions.
    match request.target {
        SessionConversionTarget::Standalone => unrelated
            .terminate_standalone(&catalog, Duration::from_secs(3))
            .unwrap(),
        SessionConversionTarget::Managed => {
            manager
                .stop_managed_create_chain_v2(
                    app,
                    unrelated.create_idempotency_key().unwrap(),
                    &unrelated.descriptor().session_id,
                    &unrelated.descriptor().workspace_id,
                )
                .unwrap();
        }
    }
    manager
        .stop_managed_create_chain_v2(app, source_key, &source.session_id, &source.workspace_id)
        .unwrap();
    assert_eq!((refused, source_preserved), (true, true), "{result:?}");
}
