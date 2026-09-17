/// Capabilities of the sole product terminal presentation path.
///
/// Development and optimized Hosts advertise the same contract. A packaged
/// Host cannot fall back to raw ANSI because every Hmux pane is a structured
/// projection client.
pub(crate) const fn capabilities_when_ready() -> [&'static str; 4] {
    [
        hmux_runtime_contract::TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
        hmux_runtime_contract::TERMINAL_INPUT_INTENT_CAPABILITY,
        hmux_runtime_contract::TERMINAL_VIEWPORT_WHEEL_CAPABILITY,
        hmux_runtime_contract::TERMINAL_VIEWPORT_MULTIPART_CAPABILITY,
    ]
}
