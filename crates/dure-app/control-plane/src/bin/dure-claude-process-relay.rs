#[cfg(unix)]
fn main() {
    match dure_control_plane::claude_process_relay::run_from_arguments(std::env::args_os().skip(1))
    {
        Ok(completion) => {
            // The relay's terminal is its Hmux session's screen: one line there
            // says how Claude ended and whether its host asked it to stop.
            use std::io::Write;
            let _ = writeln!(std::io::stderr(), "dure-claude-process-relay: {completion}");
            std::process::exit(completion.exit_code());
        }
        Err(error) => {
            eprintln!("dure-claude-process-relay: {error}");
            std::process::exit(70);
        }
    }
}

#[cfg(not(unix))]
fn main() {
    eprintln!("dure-claude-process-relay: unsupported_platform");
    std::process::exit(78);
}
