use hebbian_bounded_process::{CommandFailure, CommandSpec, TimeoutStage, run};
use std::time::Duration;

fn fixture(mode: &str) -> CommandSpec {
    let mut command = CommandSpec::new(env!("CARGO_BIN_EXE_bounded-process-fixture"));
    command.arg(mode);
    command
}

#[cfg(unix)]
#[test]
fn screenshot_sized_output_does_not_spend_its_deadline_sleeping_between_reads() {
    let count = 2 * 1024 * 1024;
    for (mode, capture_stderr) in [("write", false), ("stderr-only", true)] {
        let mut command = fixture(mode);
        command
            .arg(count.to_string())
            .capture_stderr(capture_stderr);
        let output = run(&command, Duration::from_secs(3), count)
            .expect("ready output must drain without a polling delay per pipe refill");
        assert!(output.status.success());
        assert!(!output.exceeded_limit);
        if capture_stderr {
            assert_eq!(output.stderr, vec![b'e'; count]);
            assert!(output.stdout.is_empty());
        } else {
            assert_eq!(output.stdout, vec![b'x'; count]);
            assert!(output.stderr.is_empty());
        }
    }
}

#[test]
fn input_larger_than_a_pipe_progresses_while_both_outputs_are_full() {
    let input = vec![b'i'; 512 * 1024];
    let noise = 128 * 1024;
    let mut command = fixture("exchange");
    command
        .arg(noise.to_string())
        .input(input.clone())
        .capture_stderr(true);
    let output = run(&command, Duration::from_secs(10), input.len() + noise).unwrap();
    assert!(output.status.success());
    assert!(!output.exceeded_limit);
    assert_eq!(&output.stdout[..noise], vec![b'o'; noise]);
    assert_eq!(&output.stdout[noise..], input);
    assert_eq!(output.stderr, vec![b'e'; noise]);
}

#[test]
fn stderr_is_discarded_by_default_and_can_be_selected_independently() {
    let mut command = fixture("exchange");
    command.arg("8").input(b"input".as_slice());
    for capture in [false, true, false] {
        command.capture_stderr(capture);
        let output = run(&command, Duration::from_secs(5), 16).unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout, b"ooooooooinput");
        assert_eq!(
            output.stderr,
            if capture { vec![b'e'; 8] } else { Vec::new() }
        );
    }
}

#[test]
fn stderr_has_its_own_exact_limit_and_bounded_overflow() {
    let mut command = fixture("stderr-only");
    command.arg("9").capture_stderr(true);
    for limit in [9, 8] {
        let output = run(&command, Duration::from_secs(5), limit).unwrap();
        assert!(output.stdout.is_empty());
        assert_eq!(output.stderr, vec![b'e'; 9]);
        assert_eq!(output.exceeded_limit, limit == 8);
    }
}

#[test]
fn an_unread_large_input_does_not_block_the_process_deadline() {
    let mut command = fixture("hold");
    command.input(vec![b'i'; 512 * 1024]).capture_stderr(true);
    assert_eq!(
        run(&command, Duration::from_millis(250), 16).unwrap_err(),
        CommandFailure::Timeout(TimeoutStage::ProcessExit)
    );
}

#[test]
fn empty_input_reaches_eof_and_repeated_runs_start_at_the_beginning() {
    for input in [Vec::new(), b"repeatable input".to_vec()] {
        let mut command = fixture("exchange");
        command.arg("0").input(input.clone()).capture_stderr(true);
        for _ in 0..2 {
            let output = run(&command, Duration::from_secs(5), 32).unwrap();
            assert!(output.status.success());
            assert_eq!(output.stdout, input);
            assert!(output.stderr.is_empty());
        }
    }
}

#[cfg(windows)]
#[test]
fn unqualified_program_uses_the_command_path_without_global_environment_changes() {
    let temporary = tempfile::tempdir().unwrap();
    let binaries = temporary.path().join("tools with spaces");
    std::fs::create_dir(&binaries).unwrap();
    std::fs::copy(
        env!("CARGO_BIN_EXE_bounded-process-fixture"),
        binaries.join("bounded-io.exe"),
    )
    .unwrap();
    let mut command = CommandSpec::new("bounded-io");
    command
        .args(["exchange", "0"])
        .env("PATH", binaries.as_os_str())
        .current_dir(temporary.path())
        .input(b"resolved input".as_slice())
        .capture_stderr(true);
    let output = run(&command, Duration::from_secs(5), 32)
        .expect("resolve fixture using this command's PATH");
    assert!(output.status.success());
    assert_eq!(output.stdout, b"resolved input");
    assert!(output.stderr.is_empty());
}

#[cfg(windows)]
#[test]
fn cleared_environment_uses_the_last_case_insensitive_path_override() {
    let binary = std::path::Path::new(env!("CARGO_BIN_EXE_bounded-process-fixture"));
    let mut command = CommandSpec::new(binary.file_name().unwrap());
    command
        .clear_env()
        .args(["exchange", "0"])
        .input(b"command-local PATH".as_slice());
    assert_eq!(
        run(&command, Duration::from_secs(5), 32).unwrap_err(),
        CommandFailure::Spawn
    );
    command
        .env("PATH", "")
        .env("pAtH", binary.parent().unwrap().as_os_str());
    let output = run(&command, Duration::from_secs(5), 32).unwrap();
    assert!(output.status.success());
    assert_eq!(output.stdout, b"command-local PATH");
}

#[cfg(windows)]
#[test]
fn explicit_program_does_not_depend_on_path() {
    let mut command = fixture("exchange");
    command
        .clear_env()
        .env("PATH", "")
        .arg("0")
        .input(b"explicit binary".as_slice());
    let output = run(&command, Duration::from_secs(5), 32).unwrap();
    assert!(output.status.success());
    assert_eq!(output.stdout, b"explicit binary");
}
