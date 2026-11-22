use super::*;
use dure_git_checkout::{claim_git_checkout_registration, release_git_checkout_registration};

/// A worktree removed and re-added at the same path outside Dure used to leave
/// every later launch of a session in it, Refresh included, refused with
/// `worktree_identity_changed`. The launch now proceeds under the session's
/// own claim while another owner holds the replaced checkout, then moves the
/// binding to the checkout found at that directory, under the same claim.
#[tokio::test]
async fn launch_reregisters_a_worktree_replaced_at_the_same_path() {
    let fixture = Fixture::new(false).await;
    let identity = managed_identity(
        &fixture.runtime.namespace,
        "replaced-create",
        "replaced-session",
        "replaced-workspace",
    );
    let prepare = || {
        fixture
            .runtime
            .prepare_checkout(identity.clone(), &fixture.checkout, None, || async {
                Ok::<_, SessionCheckoutError>(())
            })
    };
    let first = prepare().await.unwrap();
    assert_eq!(first.registration.as_ref(), Some(&fixture.registration));
    assert_eq!(fixture.claims(), 1);

    let other = operation("other-owner");
    claim_git_checkout_registration(&fixture.checkout, &other, Some(&fixture.registration))
        .unwrap();

    let repository = fixture.checkout.parent().unwrap().join("repository");
    let checkout = fixture.checkout.to_str().unwrap();
    git(&repository, &["worktree", "remove", "--force", checkout]);
    git(
        &repository,
        &["worktree", "add", "--detach", checkout, "HEAD"],
    );
    let live = capture_git_checkout_registration(&fixture.checkout)
        .unwrap()
        .unwrap();
    assert_ne!(live, fixture.registration);

    // While another owner still holds the replaced checkout, the launch keeps
    // this binding and its own claim, which still protects the path.
    let relaunched = prepare().await.unwrap();
    assert_eq!(relaunched, first);
    assert_eq!(fixture.claims(), 2);
    assert!(read_git_checkout_claims(&live).unwrap().is_empty());
    release_git_checkout_registration(&fixture.registration, &other, &operation("other-release"))
        .unwrap();

    let relaunched = prepare().await.unwrap();
    assert_eq!(relaunched.claim_id, first.claim_id);
    assert_eq!(relaunched.registration.as_ref(), Some(&live));
    assert_eq!(
        fixture
            .store
            .session_checkout(&identity)
            .await
            .unwrap()
            .unwrap()
            .binding,
        relaunched
    );
    let claims = read_git_checkout_claims(&live).unwrap();
    assert_eq!(claims.len(), 1);
    assert_eq!(claims[0].claim_id, relaunched.claim_id);
    // Later launches claim the recorded checkout directly.
    assert_eq!(prepare().await.unwrap(), relaunched);
    fixture.store.close().await;
}
