#[path = "../src/viewport_projection_cutover.rs"]
mod viewport_projection_cutover;

#[test]
fn optimized_release_advertises_the_complete_viewport_contract() {
    if cfg!(debug_assertions) {
        return;
    }
    let capabilities = viewport_projection_cutover::capabilities_when_ready();
    assert!(capabilities.contains(&hmux_runtime_contract::TERMINAL_VIEWPORT_PROJECTION_CAPABILITY));
    assert!(capabilities.contains(&hmux_runtime_contract::TERMINAL_INPUT_INTENT_CAPABILITY));
    assert!(capabilities.contains(&hmux_runtime_contract::TERMINAL_VIEWPORT_WHEEL_CAPABILITY));
    assert!(capabilities.contains(&hmux_runtime_contract::TERMINAL_VIEWPORT_MULTIPART_CAPABILITY));
}

#[test]
fn viewport_async_publication_cutover_red() {
    if std::env::var("HMUX_VIEWPORT_ASYNC_PUBLISH_CUTOVER_RED").as_deref() != Ok("1") {
        eprintln!("cutover RED disabled; set HMUX_VIEWPORT_ASYNC_PUBLISH_CUTOVER_RED=1 explicitly");
        return;
    }

    let mut advertised = vec![hmux_runtime_contract::TERMINAL_STATE_BINARY_CAPABILITY.to_string()];
    advertised.extend(viewport_projection_cutover::capabilities_when_ready().map(str::to_string));
    assert!(
        advertised
            .iter()
            .any(|value| value == hmux_runtime_contract::TERMINAL_VIEWPORT_PROJECTION_CAPABILITY),
        "viewport projection must remain dark until PTY ingest only advances a capacity-one \
         generation, one projector copies bounded source data under the terminal lock, and \
         frame encoding plus queue replacement run outside terminal and PTY-writer locks"
    );
    assert!(
        advertised
            .iter()
            .any(|value| value == hmux_runtime_contract::TERMINAL_INPUT_INTENT_CAPABILITY),
        "a writable development surface must negotiate semantic input with its viewport"
    );
    assert!(
        advertised.iter().any(|value| {
            value == hmux_runtime_contract::TERMINAL_VIEWPORT_MULTIPART_CAPABILITY
        }),
        "viewport advertisement must include the capability that selects terminal minor 5"
    );
}
