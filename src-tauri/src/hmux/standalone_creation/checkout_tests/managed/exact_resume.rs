use super::advance::{advance, descriptor, initial_removal, receipt};
use super::*;

fn conversation_launch(
    fixture: &Fixture,
    id: &str,
    replace_current: bool,
) -> crate::hmux::ManagedCreateLaunch {
    let mut request = launch(fixture, id);
    request.replace_current = replace_current;
    request.conversation_id = Some(format!("conversation-{id}"));
    request
}

#[test]
#[ignore = "requires isolated native app roots and staged Hmux binaries"]
fn native_exact_resume_replays_one_target_for_a_live_conversation() {
    let mut fixture = Fixture::new();
    let source = fixture
        .manager
        .create_managed(
            fixture.app.handle(),
            conversation_launch(&fixture, "writer-replay", false),
        )
        .unwrap();
    let source_descriptor = descriptor(&source);
    let result = fixture.manager.advance_managed_create(
        fixture.app.handle(),
        conversation_launch(&fixture, "writer-replay", true),
    );
    let target =
        receipt(&result).unwrap_or_else(|| panic!("live writer replacement failed: {result:?}"));
    let replay = fixture.manager.advance_managed_create(
        fixture.app.handle(),
        conversation_launch(&fixture, "writer-replay", true),
    );
    let replayed = receipt(&replay).unwrap_or_else(|| panic!("target replay failed: {replay:?}"));
    drop(std::mem::take(&mut fixture.manager));
    let mut changed = conversation_launch(&fixture, "writer-replay", true);
    changed.command = changed.command.replace("sleep 60", "sleep 61");
    let changed_replay = fixture
        .manager
        .advance_managed_create(fixture.app.handle(), changed);
    let changed_target = receipt(&changed_replay)
        .unwrap_or_else(|| panic!("ready target policy replay failed: {changed_replay:?}"));
    let claims = read_git_checkout_claims(&fixture.registration).unwrap();
    let source_process =
        hmux_client::probe_local_process_generation(&source_descriptor.provider_process).unwrap();
    close(&fixture, replayed);
    let remaining = read_git_checkout_claims(&fixture.registration).unwrap();
    close(&fixture, &source);
    assert_eq!(
        source_process,
        hmux_client::LocalProcessGenerationStatus::Absent
    );
    assert_ne!(target.session.session_id, source.session.session_id);
    assert_eq!(replayed.session.stop_fence, target.session.stop_fence);
    assert_eq!(changed_target.session.stop_fence, target.session.stop_fence);
    assert_eq!(claims.len(), 1);
    assert!(remaining.is_empty());
}

#[test]
#[ignore = "requires isolated native app roots and staged Hmux binaries"]
fn native_initial_exact_resume_cannot_launch_during_checkout_removal() {
    initial_removal("resume-removal", true);
}

#[test]
#[ignore = "requires isolated native app roots and staged Hmux binaries"]
fn native_exact_resume_target_close_releases_its_checkout() {
    let fixture = Fixture::new();
    let source = fixture
        .manager
        .create_managed(fixture.app.handle(), launch(&fixture, "resume-close"))
        .unwrap();
    let source_descriptor = descriptor(&source);
    let result = advance(&fixture, "resume-close", true);
    let target = receipt(&result).expect("Exact Resume must create its target");
    let source_process =
        hmux_client::probe_local_process_generation(&source_descriptor.provider_process).unwrap();
    let target_health = probe_local_session_exact(&product_catalog().unwrap(), &descriptor(target));
    close(&fixture, target);
    let remaining = read_git_checkout_claims(&fixture.registration).unwrap();
    // Collect the target-close observation before cleaning the old source.
    close(&fixture, &source);
    assert_eq!(
        (source_process, target_health),
        (
            hmux_client::LocalProcessGenerationStatus::Absent,
            SessionProbeStatus::Healthy
        )
    );
    assert!(
        remaining.is_empty(),
        "Exact Resume left its source's checkout claim after target close: {remaining:?}"
    );
}

#[test]
#[ignore = "requires isolated native app roots and staged Hmux binaries"]
fn native_exact_resume_cannot_stop_a_source_under_a_removal_permit() {
    let fixture = Fixture::new();
    let source = fixture
        .manager
        .create_managed(
            fixture.app.handle(),
            conversation_launch(&fixture, "resume-permit", false),
        )
        .unwrap();
    let source_descriptor = descriptor(&source);
    let claims = read_git_checkout_claims(&fixture.registration).unwrap();
    assert_eq!(claims.len(), 1);
    let permit = fixture
        .removal("remove-owned-source")
        .retiring_registration(&claims[0].claim_id)
        .admit()
        .unwrap();
    let before = product_catalog().unwrap().list().unwrap().len();
    let result = fixture.manager.advance_managed_create(
        fixture.app.handle(),
        conversation_launch(&fixture, "resume-permit", true),
    );
    let after = product_catalog().unwrap().list().unwrap().len();
    let health = probe_local_session_exact(&product_catalog().unwrap(), &source_descriptor);
    let launched = receipt(&result);
    if let Some(target) = launched {
        close(&fixture, target);
    }
    permit.abort().unwrap();
    close(&fixture, &source);
    assert_eq!(
        (launched.is_some(), after, health),
        (false, before, SessionProbeStatus::Healthy),
        "removal admission must preserve its source: {result:?}"
    );
}
