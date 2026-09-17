use super::*;
use hmux_session_protocol::browser_resource::BrowserResourceId;

fn resource(id: &str) -> BrowserResourceIdentity {
    BrowserResourceIdentity {
        resource_id: BrowserResourceId::new(id).unwrap(),
        workspace_id: BrowserWorkspaceId::new("workspace:one").unwrap(),
        generation: BrowserResourceGeneration::new("generation:one").unwrap(),
    }
}

#[test]
fn creation_selects_and_close_clears_without_guessing_another_resource() {
    let first = resource("first");
    let second = resource("second");
    let mut host =
        BrowserWorkspaceTargetHost::new(first.workspace_id.clone(), first.generation.clone());
    let initial = host.projection();
    let created = host.created(&first).unwrap();
    assert_eq!(created.revision.get(), 2);
    let selected = host.created(&second).unwrap();
    assert_eq!(selected.current_resource, Some(second.clone()));
    assert_eq!(
        host.select(&initial, &first),
        Err(BrowserWorkspaceTargetError::SelectionChanged)
    );
    assert_eq!(host.select(&selected, &second).unwrap(), selected);
    assert_eq!(host.retired(&first).unwrap(), selected);
    let cleared = host.retired(&second).unwrap();
    assert_eq!(cleared.current_resource, None);
    assert_eq!(cleared.revision.get(), 4);
    assert_eq!(host.retired(&second).unwrap(), cleared);
    assert_eq!(
        host.select(&selected, &first),
        Err(BrowserWorkspaceTargetError::SelectionChanged)
    );
    assert_eq!(
        host.select(&cleared, &first).unwrap().current_resource,
        Some(first)
    );
}

#[test]
fn workspace_generation_and_full_expected_projection_are_fenced_without_mutation() {
    let first = resource("first");
    let mut host =
        BrowserWorkspaceTargetHost::new(first.workspace_id.clone(), first.generation.clone());
    let target = host.created(&first).unwrap();
    for other in [
        BrowserResourceIdentity {
            workspace_id: BrowserWorkspaceId::new("foreign").unwrap(),
            ..first.clone()
        },
        BrowserResourceIdentity {
            generation: BrowserResourceGeneration::new("replacement").unwrap(),
            ..first.clone()
        },
    ] {
        assert_eq!(
            host.created(&other),
            Err(BrowserWorkspaceTargetError::IdentityMismatch)
        );
        assert_eq!(
            host.select(&target, &other),
            Err(BrowserWorkspaceTargetError::IdentityMismatch)
        );
        assert_eq!(
            host.retired(&other),
            Err(BrowserWorkspaceTargetError::IdentityMismatch)
        );
        assert_eq!(host.projection(), target);
    }
    let mut wrong = target.clone();
    wrong.current_resource = None;
    assert_eq!(
        host.select(&wrong, &first),
        Err(BrowserWorkspaceTargetError::SelectionChanged)
    );
    assert_eq!(host.projection(), target);
}

#[test]
fn exhausted_revision_never_partially_changes_selection() {
    let first = resource("first");
    let mut host =
        BrowserWorkspaceTargetHost::new(first.workspace_id.clone(), first.generation.clone());
    host.created(&first).unwrap();
    host.target.revision = NonZeroU64::new(u64::MAX).unwrap();
    let last = host.projection();
    assert_eq!(
        host.created(&resource("second")),
        Err(BrowserWorkspaceTargetError::RevisionExhausted)
    );
    assert_eq!(
        host.retired(&first),
        Err(BrowserWorkspaceTargetError::RevisionExhausted)
    );
    assert_eq!(host.select(&last, &first).unwrap(), last);
    assert_eq!(host.projection(), last);
}
