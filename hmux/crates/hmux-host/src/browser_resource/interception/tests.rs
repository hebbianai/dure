use super::*;
use serde_json::json;

fn setup() -> (
    BrowserResourceHost,
    BrowserPageIdentity,
    BrowserControllerLease,
) {
    let resource = BrowserResourceIdentity {
        resource_id: BrowserResourceId::new("r").unwrap(),
        generation: BrowserResourceGeneration::new("g").unwrap(),
        workspace_id: BrowserWorkspaceId::new("w").unwrap(),
    };
    let mut host = BrowserResourceHost::new(resource);
    let page = host
        .register_page(
            BrowserInstanceId::new("instance").unwrap(),
            BrowserTargetId::new("target").unwrap(),
            BrowserDocumentId::new("doc").unwrap(),
        )
        .unwrap();
    let lease = host
        .request_control(BrowserControllerId::new("agent").unwrap(), None)
        .unwrap()
        .controller
        .unwrap();
    (host, page, lease)
}

fn permit(
    host: &mut BrowserResourceHost,
    page: &BrowserPageIdentity,
    lease: &BrowserControllerLease,
) -> BrowserActionPermit {
    let sequence = host.projection().next_command_sequence;
    host.begin_action(
        &lease.controller_id,
        &BrowserActionAuthority {
            lease: lease.clone(),
            page: page.clone(),
            operation_id: BrowserOperationId::new(format!("op:{sequence}")).unwrap(),
            command_sequence: sequence,
        },
        [],
    )
    .unwrap()
}

fn enable(effect: serde_json::Value) -> BrowserInterceptionAction {
    serde_json::from_value(
        json!({"kind":"enable","rule":{"patterns":["*/one","*/two"],"effect":effect}}),
    )
    .unwrap()
}

#[test]
fn interception_belongs_to_page_lifetime_across_documents_and_controllers() {
    let (mut host, page, lease) = setup();
    let permit = permit(&mut host, &page, &lease);
    let target = host
        .configure_interception(&permit, &enable(json!({"kind":"abort"})))
        .unwrap();
    assert!(
        !host
            .interception_status(&page.resource, &page.page_id, true)
            .unwrap()
            .available
    );
    host.interception_applied(&target).unwrap();
    host.finish_action(permit, BrowserActionOutcome::Completed)
        .unwrap();
    host.document_committed(&page.page_id, BrowserDocumentId::new("next").unwrap())
        .unwrap();
    host.request_control(BrowserControllerId::new("human").unwrap(), Some(&lease))
        .unwrap();
    for url in ["https://x/one", "https://x/two"] {
        assert!(matches!(
            host.intercepted_request(&target, url, Some("Fetch")),
            Some(BrowserRequestEffect::Abort)
        ));
    }
    let status = host
        .interception_status(&page.resource, &page.page_id, false)
        .unwrap();
    assert!(status.enabled && !status.available);
    let other = BrowserTargetId::new("neighbor").unwrap();
    host.register_page(
        BrowserInstanceId::new("instance").unwrap(),
        other.clone(),
        BrowserDocumentId::new("other").unwrap(),
    )
    .unwrap();
    assert!(matches!(
        host.intercepted_request(&other, "https://x/one", Some("Fetch")),
        Some(BrowserRequestEffect::Continue)
    ));
    host.page_closed(&page.page_id).unwrap();
    host.register_page(
        BrowserInstanceId::new("instance").unwrap(),
        target.clone(),
        BrowserDocumentId::new("replacement").unwrap(),
    )
    .unwrap();
    assert!(!host.interception_enabled(&target));
}

#[test]
fn stale_document_permit_does_not_change_interception() {
    let (mut host, page, lease) = setup();
    let permit = permit(&mut host, &page, &lease);
    host.document_committed(&page.page_id, BrowserDocumentId::new("next").unwrap())
        .unwrap();
    assert_eq!(
        host.configure_interception(&permit, &enable(json!({"kind":"abort"})))
            .unwrap_err(),
        BrowserAdmissionError::DocumentChanged
    );
    assert!(
        !host
            .interception_status(&page.resource, &page.page_id, true)
            .unwrap()
            .enabled
    );
    host.finish_action(permit, BrowserActionOutcome::RejectedBeforeDispatch)
        .unwrap();
}

#[test]
fn rule_budget_rejects_without_mutation_and_close_returns_resource_capacity() {
    let (mut host, page, lease) = setup();
    let large =
        enable(json!({"kind":"respond","status":200,"body":"a".repeat(200_000),"headers":{}}));
    for _ in 0..2 {
        let permit = permit(&mut host, &page, &lease);
        host.configure_interception(&permit, &large).unwrap();
        host.finish_action(permit, BrowserActionOutcome::Completed)
            .unwrap();
    }
    let next = host
        .register_page(
            BrowserInstanceId::new("instance").unwrap(),
            BrowserTargetId::new("next").unwrap(),
            BrowserDocumentId::new("doc2").unwrap(),
        )
        .unwrap();
    let denied = permit(&mut host, &next, &lease);
    assert_eq!(
        host.configure_interception(&denied, &large).unwrap_err(),
        BrowserAdmissionError::CapacityExceeded
    );
    assert!(
        !host
            .interception_status(&next.resource, &next.page_id, true)
            .unwrap()
            .enabled
    );
    host.finish_action(denied, BrowserActionOutcome::RejectedBeforeDispatch)
        .unwrap();
    host.page_closed(&page.page_id).unwrap();
    let accepted = permit(&mut host, &next, &lease);
    host.configure_interception(&accepted, &large).unwrap();
    host.finish_action(accepted, BrowserActionOutcome::Completed)
        .unwrap();
    let disabled = permit(&mut host, &next, &lease);
    host.configure_interception(&disabled, &BrowserInterceptionAction::Disable)
        .unwrap();
    host.finish_action(disabled, BrowserActionOutcome::Completed)
        .unwrap();
    assert!(
        !host
            .interception_status(&next.resource, &next.page_id, true)
            .unwrap()
            .enabled
    );
}

#[test]
fn pass_rules_do_not_hide_later_effects_and_first_effect_wins() {
    let (mut host, page, lease) = setup();
    for effect in [
        json!({"kind":"continue"}),
        json!({"kind":"abort"}),
        json!({"kind":"respond","status":200,"body":"later","headers":{}}),
    ] {
        let permit = permit(&mut host, &page, &lease);
        host.configure_interception(&permit, &enable(effect))
            .unwrap();
        host.finish_action(permit, BrowserActionOutcome::Completed)
            .unwrap();
    }
    assert!(matches!(
        host.intercepted_request(
            host.target_for(&page).unwrap(),
            "https://x/two",
            Some("Fetch")
        ),
        Some(BrowserRequestEffect::Abort)
    ));
}

#[test]
fn removing_exact_patterns_preserves_other_rules_pages_and_first_effect() {
    let (mut host, page, lease) = setup();
    let other = host
        .register_page(
            BrowserInstanceId::new("instance").unwrap(),
            BrowserTargetId::new("other").unwrap(),
            BrowserDocumentId::new("other-doc").unwrap(),
        )
        .unwrap();
    for (page, effect) in [
        (&page, json!({"kind":"abort"})),
        (
            &page,
            json!({"kind":"respond","status":200,"body":"later","headers":{}}),
        ),
        (&other, json!({"kind":"abort"})),
    ] {
        let permit = permit(&mut host, page, &lease);
        host.configure_interception(&permit, &enable(effect))
            .unwrap();
        host.finish_action(permit, BrowserActionOutcome::Completed)
            .unwrap();
    }
    let target = host.target_for(&page).unwrap().clone();
    for pattern in ["https://x/one", "*/one"] {
        let permit = permit(&mut host, &page, &lease);
        let remove = serde_json::from_value(json!({"kind":"remove","pattern":pattern})).unwrap();
        host.configure_interception(&permit, &remove).unwrap();
        let status = host
            .interception_status(&page.resource, &page.page_id, true)
            .unwrap();
        assert!(status.enabled && !status.available);
        assert_eq!(status.rules.len(), 2);
        for rule in status.rules {
            let patterns: Vec<_> = rule
                .patterns()
                .iter()
                .map(BrowserUrlPattern::as_str)
                .collect();
            assert_eq!(
                patterns,
                if pattern == "*/one" {
                    vec!["*/two"]
                } else {
                    vec!["*/one", "*/two"]
                }
            );
        }
        assert!(matches!(
            host.intercepted_request(&target, "https://x/two", Some("Fetch")),
            Some(BrowserRequestEffect::Abort)
        ));
        assert!(matches!(
            host.intercepted_request(
                host.target_for(&other).unwrap(),
                "https://x/one",
                Some("Fetch")
            ),
            Some(BrowserRequestEffect::Abort)
        ));
        host.interception_applied(&target).unwrap();
        host.finish_action(permit, BrowserActionOutcome::Completed)
            .unwrap();
    }
    assert!(matches!(
        host.intercepted_request(&target, "https://x/one", Some("Fetch")),
        Some(BrowserRequestEffect::Continue)
    ));
    let remove = serde_json::from_value(json!({"kind":"remove","pattern":"*/two"})).unwrap();
    let permit = permit(&mut host, &page, &lease);
    host.configure_interception(&permit, &remove).unwrap();
    assert!(!host.interception_enabled(&target));
    assert!(host
        .interception_status(&page.resource, &page.page_id, true)
        .unwrap()
        .rules
        .is_empty());
    host.finish_action(permit, BrowserActionOutcome::Completed)
        .unwrap();
}

#[test]
fn stale_remove_does_not_mutate_rules_and_removal_returns_pattern_capacity() {
    let (mut host, page, lease) = setup();
    for _ in 0..16 {
        let permit = permit(&mut host, &page, &lease);
        host.configure_interception(&permit, &enable(json!({"kind":"abort"})))
            .unwrap();
        host.finish_action(permit, BrowserActionOutcome::Completed)
            .unwrap();
    }
    let remove: BrowserInterceptionAction =
        serde_json::from_value(json!({"kind":"remove","pattern":"*/one"})).unwrap();
    let stale = permit(&mut host, &page, &lease);
    host.document_committed(&page.page_id, BrowserDocumentId::new("next").unwrap())
        .unwrap();
    assert_eq!(
        host.configure_interception(&stale, &remove).unwrap_err(),
        BrowserAdmissionError::DocumentChanged
    );
    host.finish_action(stale, BrowserActionOutcome::RejectedBeforeDispatch)
        .unwrap();
    let page = host.page_identity(&page.page_id).unwrap();
    assert_eq!(
        host.interception_status(&page.resource, &page.page_id, true)
            .unwrap()
            .rules
            .iter()
            .map(|r| r.patterns().len())
            .sum::<usize>(),
        32
    );
    let accepted = permit(&mut host, &page, &lease);
    host.configure_interception(&accepted, &remove).unwrap();
    host.finish_action(accepted, BrowserActionOutcome::Completed)
        .unwrap();
    let next = permit(&mut host, &page, &lease);
    host.configure_interception(&next, &enable(json!({"kind":"abort"})))
        .unwrap();
    host.finish_action(next, BrowserActionOutcome::Completed)
        .unwrap();
    assert_eq!(
        host.interception_status(&page.resource, &page.page_id, true)
            .unwrap()
            .rules
            .iter()
            .map(|r| r.patterns().len())
            .sum::<usize>(),
        18
    );
}
