use super::*;

fn add(host: &mut BrowserResourceHost, instance: &str, target: &str) -> BrowserPageIdentity {
    host.register_page(
        BrowserInstanceId::new(instance).unwrap(),
        BrowserTargetId::new(target).unwrap(),
        BrowserDocumentId::new(format!("document:{target}")).unwrap(),
    )
    .unwrap()
}

#[test]
fn current_target_follows_activation_and_ignores_other_profile_observations() {
    let (mut host, lease, first) = setup();
    let other = add(&mut host, "other-instance", "other-target");
    assert_eq!(host.current_page(), Some(first.clone()));
    let before = host.projection();
    host.active_page_observed(
        &BrowserInstanceId::new("other-instance").unwrap(),
        Some(&BrowserTargetId::new("other-target").unwrap()),
    )
    .unwrap();
    assert_eq!(host.projection(), before);
    let permit = host
        .begin_action(&lease.controller_id, &action(&host, &lease, &other), [])
        .unwrap();
    assert_eq!(
        host.page_activated(&permit, &first),
        Err(BrowserAdmissionError::PermitMismatch)
    );
    host.page_activated(&permit, &other).unwrap();
    host.finish_action(permit, BrowserActionOutcome::Completed)
        .unwrap();
    host.active_page_observed(
        &BrowserInstanceId::new("instance").unwrap(),
        Some(&BrowserTargetId::new("target:1").unwrap()),
    )
    .unwrap();
    assert_eq!(host.current_page(), Some(other));
}

#[test]
fn closing_current_uses_an_observed_active_tab_and_never_an_arbitrary_page() {
    let (mut host, _, first) = setup();
    let second = add(&mut host, "instance", "second");
    let third = add(&mut host, "instance", "third");
    host.page_closed(&first.page_id).unwrap();
    assert_eq!(host.current_page(), None);
    host.active_page_observed(
        &BrowserInstanceId::new("instance").unwrap(),
        Some(&BrowserTargetId::new("third").unwrap()),
    )
    .unwrap();
    assert_eq!(host.current_page(), Some(third.clone()));
    host.page_closed(&second.page_id).unwrap();
    assert_eq!(host.current_page(), Some(third));
}

#[test]
fn closing_last_profile_page_observes_the_remaining_profile_and_exhaustion_clears_target() {
    let (mut host, _, first) = setup();
    let other = add(&mut host, "other-instance", "other-target");
    host.page_closed(&first.page_id).unwrap();
    assert_eq!(host.current_page(), None);
    host.active_page_observed(&BrowserInstanceId::new("instance").unwrap(), None)
        .unwrap();
    assert_eq!(host.current_page(), None);
    host.active_page_observed(
        &BrowserInstanceId::new("other-instance").unwrap(),
        Some(&BrowserTargetId::new("other-target").unwrap()),
    )
    .unwrap();
    assert_eq!(host.current_page(), Some(other.clone()));
    host.page_closed(&other.page_id).unwrap();
    assert_eq!(host.current_page(), None);
}

#[test]
fn handoff_keeps_the_target_and_navigation_projects_its_current_document() {
    let (mut host, lease, first) = setup();
    let next = host
        .request_control(controller("next"), Some(&lease))
        .unwrap();
    assert_eq!(next.current_page, Some(first.clone()));
    let old = action(&host, &lease, &first);
    assert!(matches!(
        host.begin_action(&lease.controller_id, &old, []),
        Err(BrowserAdmissionError::ControllerChanged)
    ));
    let document = host
        .document_committed(
            &first.page_id,
            BrowserDocumentId::new("next-document").unwrap(),
        )
        .unwrap();
    assert_eq!(host.current_page(), Some(document));
    host.engine_exited(&first.resource).unwrap();
    assert_eq!(host.current_page(), None);
}

#[test]
fn consecutive_closes_move_pending_selection_past_retiring_profiles() {
    let (mut host, _, first) = setup();
    let second = add(&mut host, "instance", "second");
    let retiring = add(&mut host, "retiring-instance", "retiring-target");
    let other = add(&mut host, "other-instance", "other-target");
    host.begin_instance_retirement(
        &first.resource,
        &BrowserInstanceId::new("retiring-instance").unwrap(),
    )
    .unwrap();
    host.page_closed(&first.page_id).unwrap();
    host.page_closed(&second.page_id).unwrap();
    host.active_page_observed(
        &BrowserInstanceId::new("retiring-instance").unwrap(),
        Some(&BrowserTargetId::new("retiring-target").unwrap()),
    )
    .unwrap();
    assert_eq!(host.current_page(), None);
    host.active_page_observed(
        &BrowserInstanceId::new("other-instance").unwrap(),
        Some(&BrowserTargetId::new("other-target").unwrap()),
    )
    .unwrap();
    assert_eq!(host.current_page(), Some(other.clone()));
    host.page_closed(&other.page_id).unwrap();
    host.page_closed(&retiring.page_id).unwrap();
    let fresh = add(&mut host, "fresh-instance", "fresh-target");
    assert_eq!(host.current_page(), Some(fresh));
}

#[test]
fn an_observation_of_another_resources_active_tab_preserves_the_target() {
    let (mut host, _, first) = setup();
    let before = host.projection();
    host.active_page_observed(&BrowserInstanceId::new("instance").unwrap(), None)
        .unwrap();
    assert_eq!(host.projection(), before);
    assert_eq!(host.current_page(), Some(first));
}
