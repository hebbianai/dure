#[cfg(unix)]
fn main() {
    if let Err(error) =
        dure_control_plane::claude_process_relay::run_from_arguments(std::env::args_os().skip(1))
    {
        eprintln!("dure-claude-process-relay: {error}");
        std::process::exit(70);
    }
}

#[cfg(not(unix))]
fn main() {
    eprintln!("dure-claude-process-relay: unsupported_platform");
    std::process::exit(78);
}
