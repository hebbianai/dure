use std::fs;
use std::io::{self, Read, Write};
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;

#[cfg(unix)]
#[path = "bounded_process_fixture/git_execution_lifetime.rs"]
mod git_execution_lifetime;

fn main() {
    let mut arguments = std::env::args().skip(1);
    let mode = arguments.next().expect("fixture mode");
    match mode.as_str() {
        #[cfg(unix)]
        "git-parent-loss" => git_execution_lifetime::run(arguments),
        #[cfg(unix)]
        "git-post-checkout" => git_execution_lifetime::post_checkout(),
        "hold" => hold(),
        "exchange" => {
            let count = arguments
                .next()
                .expect("noise byte count")
                .parse::<usize>()
                .unwrap();
            io::stderr()
                .write_all(&vec![b'e'; count])
                .expect("write fixture stderr");
            io::stdout()
                .write_all(&vec![b'o'; count])
                .expect("write fixture stdout");
            let mut input = Vec::new();
            io::stdin()
                .read_to_end(&mut input)
                .expect("read fixture stdin");
            io::stdout().write_all(&input).expect("echo fixture input");
        }
        "stderr-only" => {
            let count = arguments
                .next()
                .expect("stderr byte count")
                .parse::<usize>()
                .unwrap();
            io::stderr()
                .write_all(&vec![b'e'; count])
                .expect("write fixture stderr");
        }
        "spawn-descendant" => {
            let pid_file = arguments.next().expect("descendant pid file");
            let parent_mode = arguments.next().expect("parent mode");
            let stdout_mode = arguments.next().expect("stdout mode");
            let mut command = Command::new(std::env::current_exe().expect("fixture executable"));
            command.arg("hold");
            if stdout_mode == "null" {
                command.stdout(Stdio::null());
            }
            let mut child = command.spawn().expect("spawn fixture descendant");
            fs::write(
                std::path::Path::new(&pid_file).with_extension("leader"),
                std::process::id().to_string(),
            )
            .expect("write leader pid");
            fs::write(&pid_file, child.id().to_string()).expect("write descendant pid");
            assert!(
                child
                    .try_wait()
                    .expect("observe fixture descendant")
                    .is_none(),
                "fixture descendant exited before the ownership test"
            );
            match parent_mode.as_str() {
                "hold" => hold(),
                "exit" => {
                    if stdout_mode == "null" {
                        print!("ok");
                    }
                }
                "overflow-stdout" | "overflow-stderr" => {
                    if parent_mode == "overflow-stdout" {
                        write_bytes(11);
                    } else {
                        io::stderr().write_all(b"xxxxxxxxxxx").unwrap();
                        io::stderr().flush().unwrap();
                    }
                    hold();
                }
                _ => panic!("unknown parent mode"),
            }
        }
        "write" => {
            let count = arguments
                .next()
                .expect("byte count")
                .parse::<usize>()
                .expect("valid byte count");
            write_bytes(count);
        }
        "write-then-hold" => {
            let count = arguments
                .next()
                .expect("byte count")
                .parse::<usize>()
                .expect("valid byte count");
            write_bytes(count);
            hold();
        }
        "env-state" => {
            let variable = arguments.next().expect("environment variable");
            print!(
                "{}",
                if std::env::var_os(variable).is_some() {
                    "present"
                } else {
                    "absent"
                }
            );
        }
        "env-value" => {
            let variable = arguments.next().expect("environment variable");
            print!("{}", std::env::var(variable).unwrap_or_default());
        }
        "process-id" => print!("{}", std::process::id()),
        #[cfg(unix)]
        "assert-fds-closed" => {
            for descriptor in arguments {
                let descriptor = descriptor.parse::<libc::c_int>().expect("file descriptor");
                let result = unsafe { libc::fcntl(descriptor, libc::F_GETFD) };
                assert_eq!(result, -1, "barrier file descriptor {descriptor} leaked");
                assert_eq!(
                    io::Error::last_os_error().raw_os_error(),
                    Some(libc::EBADF),
                    "barrier file descriptor {descriptor} was not closed"
                );
            }
            print!("closed");
        }
        "write-relative" => {
            let path = arguments.next().expect("relative output path");
            fs::write(path, b"written").expect("write relative fixture output");
        }
        "write-below-env" => {
            let variable = arguments.next().expect("environment variable");
            let path = arguments.next().expect("relative output path");
            let directory = std::env::var_os(variable).expect("directory environment value");
            fs::write(std::path::Path::new(&directory).join(path), b"written")
                .expect("write environment-rooted fixture output");
        }
        "write-relative-after-barrier" => {
            let ready = arguments.next().expect("ready path");
            let release = arguments.next().expect("release path");
            let path = arguments.next().expect("relative output path");
            wait_for_release(&ready, &release);
            fs::write(path, b"written").expect("write relative fixture output");
        }
        "write-below-env-after-barrier" => {
            let variable = arguments.next().expect("environment variable");
            let ready = arguments.next().expect("ready path");
            let release = arguments.next().expect("release path");
            let path = arguments.next().expect("relative output path");
            wait_for_release(&ready, &release);
            let directory = std::env::var_os(variable).expect("directory environment value");
            fs::write(std::path::Path::new(&directory).join(path), b"written")
                .expect("write environment-rooted fixture output");
        }
        _ => panic!("unknown fixture mode"),
    }
}

fn wait_for_release(ready: &str, release: &str) {
    fs::write(ready, b"ready").expect("publish fixture readiness");
    while !std::path::Path::new(release).exists() {
        thread::sleep(Duration::from_millis(5));
    }
}

fn write_bytes(count: usize) {
    let bytes = vec![b'x'; count];
    io::stdout()
        .write_all(&bytes)
        .expect("write fixture output");
    io::stdout().flush().expect("flush fixture output");
}

fn hold() -> ! {
    loop {
        thread::sleep(Duration::from_secs(60));
    }
}
