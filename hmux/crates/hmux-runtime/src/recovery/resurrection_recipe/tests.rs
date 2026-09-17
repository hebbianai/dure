use super::*;

#[test]
fn next_recipe_publish_reclaims_one_deterministic_crash_pending_entry() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let recipe = StandaloneResurrectionRecipe::new(
        "pending-recovery",
        state.path().canonicalize().unwrap(),
        vec!["/bin/sh".into()],
        24,
        80,
        1,
    )
    .unwrap();
    let prepared = prepare_resurrection_recipe(&discovery_root, &recipe).unwrap();
    let pending = prepared.temporary.clone();
    std::mem::forget(prepared);
    assert!(
        pending.is_file(),
        "fault fixture did not leave pending state"
    );

    save_resurrection_recipe(&discovery_root, &recipe).unwrap();

    assert!(
        !pending.exists(),
        "a later authoritative publish must reclaim crash pending state"
    );
    assert_eq!(
        read_resurrection_recipe(&discovery_root, recipe.session_name()).unwrap(),
        recipe
    );
}
