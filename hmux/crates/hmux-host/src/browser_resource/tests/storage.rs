use super::*;

#[test]
fn storage_origins_survive_navigation_but_not_stale_observation_or_replacement() {
    let (mut host, lease, page) = setup();
    host.storage_origin_observed(&page, "https://first.test".into())
        .unwrap();
    host.document_committed(&page.page_id, BrowserDocumentId::new("next").unwrap())
        .unwrap();
    assert_eq!(
        host.storage_origin_observed(&page, "https://stale.test".into()),
        Err(BrowserAdmissionError::DocumentChanged)
    );
    let current = host.page_identity(&page.page_id).unwrap();
    host.storage_origin_observed(&current, "https://second.test".into())
        .unwrap();
    assert_eq!(
        host.storage_origins(&current)
            .unwrap()
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>(),
        ["https://first.test", "https://second.test"]
    );
    let mut permit = host
        .begin_action(&lease.controller_id, &action(&host, &lease, &current), [])
        .unwrap();
    let instance = BrowserInstanceId::new("next-profile").unwrap();
    host.register_instance_binding(&resource(), instance.clone())
        .unwrap();
    let creation = host.prepare_page_replacement(&permit, &instance).unwrap();
    host.begin_page_creation(&creation, &instance).unwrap();
    let target = BrowserTargetId::new("replacement").unwrap();
    host.reserve_created_page_target(&creation, target.clone())
        .unwrap();
    host.observe_page_document(
        instance,
        target.clone(),
        BrowserDocumentId::new("replacement-doc").unwrap(),
    )
    .unwrap();
    let (replaced, _) = host.replace_page_binding(&mut permit, &target).unwrap();
    assert_eq!(host.storage_origins(&replaced).unwrap().len(), 0);
    assert!(host.storage_origins(&current).is_err());
}

#[test]
fn storage_origin_overflow_is_explicit_without_stopping_browsing_or_leaking_to_neighbors() {
    for large in [false, true] {
        let (mut host, _, page) = setup();
        let neighbor = host
            .register_page(
                BrowserInstanceId::new("instance").unwrap(),
                BrowserTargetId::new("neighbor").unwrap(),
                BrowserDocumentId::new("neighbor-doc").unwrap(),
            )
            .unwrap();
        for i in 0..1024 {
            host.storage_origin_observed(
                &page,
                format!(
                    "https://site-{i}.test{}",
                    if large {
                        "/".repeat(1024)
                    } else {
                        String::new()
                    }
                ),
            )
            .unwrap();
        }
        if !large {
            assert_eq!(host.storage_origins(&page).unwrap().len(), 1024);
        }
        host.storage_origin_observed(&page, "https://overflow.test".into())
            .unwrap();
        assert_eq!(
            host.storage_origins(&page),
            Err(BrowserAdmissionError::CapacityExceeded)
        );
        assert!(host.target_for(&page).is_ok());
        assert!(host.storage_origins(&neighbor).unwrap().is_empty());
    }
}

#[test]
fn temporary_interception_requires_the_active_accounted_creation_and_live_source() {
    use hmux_session_protocol::browser_interception::{
        BrowserInterceptionAction, BrowserRequestEffect,
    };
    let (mut host, lease, page) = setup();
    let rule: BrowserInterceptionAction = serde_json::from_value(serde_json::json!({"kind":"enable","rule":{"patterns":["*"],"effect":{"kind":"respond","body":"blank","status":200,"headers":{}}}})).unwrap();
    let permit = host
        .begin_action(&lease.controller_id, &action(&host, &lease, &page), [])
        .unwrap();
    assert!(
        host.configure_created_page_interception(&permit, &rule)
            .is_err()
    );
    let creation = host.prepare_page_creation(&permit).unwrap();
    let instance = BrowserInstanceId::new("instance").unwrap();
    host.begin_page_creation(&creation, &instance).unwrap();
    assert!(
        host.configure_created_page_interception(&permit, &rule)
            .is_err()
    );
    let target = BrowserTargetId::new("temporary").unwrap();
    host.reserve_created_page_target(&creation, target.clone())
        .unwrap();
    host.register_page(
        instance,
        target.clone(),
        BrowserDocumentId::new("temporary-doc").unwrap(),
    )
    .unwrap();
    assert_eq!(
        host.configure_created_page_interception(&permit, &rule),
        Ok(target.clone())
    );
    assert!(matches!(
        host.intercepted_request(&target, "https://example.test/", Some("Document")),
        Some(BrowserRequestEffect::Respond { .. })
    ));
    assert!(matches!(
        host.intercepted_request(
            host.target_for(&page).unwrap(),
            "https://example.test/",
            Some("Document")
        ),
        Some(BrowserRequestEffect::Continue)
    ));
    host.document_committed(&page.page_id, BrowserDocumentId::new("unrelated").unwrap())
        .unwrap();
    assert_eq!(
        host.configure_created_page_interception(&permit, &BrowserInterceptionAction::Disable),
        Err(BrowserAdmissionError::DocumentChanged)
    );
    assert!(host.interception_enabled(&target));
    host.finish_action(permit, BrowserActionOutcome::Completed)
        .unwrap();
    let current = host.page_identity(&page.page_id).unwrap();
    let next = host
        .begin_action(&lease.controller_id, &action(&host, &lease, &current), [])
        .unwrap();
    assert!(
        host.configure_created_page_interception(&next, &rule)
            .is_err()
    );
}
