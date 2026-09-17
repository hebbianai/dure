use std::io;
use std::net::TcpListener;
use std::time::Duration;

use tiny_http::{Request, Server};

pub(super) struct LocalApiListener {
    // Retain the bound socket when tiny_http stops its accept thread. Rebinding
    // could lose the published address to another process during recovery.
    listener: TcpListener,
    server: Option<Server>,
}

impl LocalApiListener {
    pub(super) fn bind(port: u16) -> io::Result<Self> {
        let listener = TcpListener::bind(("127.0.0.1", port))?;
        let server = Some(Self::accept_server(&listener)?);
        Ok(Self { listener, server })
    }

    fn accept_server(listener: &TcpListener) -> io::Result<Server> {
        Server::from_listener(listener.try_clone()?, None).map_err(io::Error::other)
    }
}

impl Iterator for LocalApiListener {
    type Item = Request;

    fn next(&mut self) -> Option<Request> {
        loop {
            if let Some(server) = &self.server {
                match server.recv() {
                    Ok(request) => return Some(request),
                    Err(error) => {
                        eprintln!("Dure local API listener stopped: {error}");
                        // recv() cannot resume tiny_http's terminated accept
                        // thread. Replace it without changing socket ownership,
                        // the descriptor generation, or the request broker.
                        self.server = None;
                    }
                }
            }
            // Resource exhaustion may persist. Pace accept-worker recreation
            // while the retained listener keeps the same address reserved.
            std::thread::sleep(Duration::from_millis(250));
            match Self::accept_server(&self.listener) {
                Ok(server) => self.server = Some(server),
                Err(error) => eprintln!("could not resume Dure local API listener: {error}"),
            }
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::fs::File;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::{SocketAddr, TcpStream};
    use std::process::{Child, Command, Stdio};
    use std::sync::mpsc;
    use std::time::Duration;

    const CHILD_ENV: &str = "DURE_TEST_LOCAL_API_FD_EXHAUSTION";
    const TIMEOUT: Duration = Duration::from_secs(5);

    struct OwnedChild(Child);

    impl Drop for OwnedChild {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    fn lines(reader: impl Read + Send + 'static) -> mpsc::Receiver<String> {
        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(reader).lines() {
                if sender.send(line.unwrap()).is_err() {
                    break;
                }
            }
        });
        receiver
    }

    fn await_line(receiver: &mpsc::Receiver<String>, prefix: &str) -> String {
        let deadline = std::time::Instant::now() + TIMEOUT;
        loop {
            let line = receiver
                .recv_timeout(deadline.saturating_duration_since(std::time::Instant::now()))
                .expect("fixture did not reach the expected listener state");
            if let Some(value) = line.strip_prefix(prefix) {
                return value.to_owned();
            }
        }
    }

    fn exhaust_descriptors_in_child() {
        // Limit only this disposable subprocess, never the app or the test runner.
        let mut limit = libc::rlimit {
            rlim_cur: 0,
            rlim_max: 0,
        };
        assert_eq!(
            unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) },
            0
        );
        limit.rlim_cur = limit.rlim_cur.min(128);
        assert_eq!(unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &limit) }, 0);

        let listener = LocalApiListener::bind(0).unwrap();
        let address = listener.listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for request in listener {
                request
                    .respond(tiny_http::Response::from_string("available"))
                    .ok();
            }
        });
        let mut files = Vec::new();
        loop {
            match File::open("/dev/null") {
                Ok(file) => files.push(file),
                Err(error) => {
                    assert_eq!(error.raw_os_error(), Some(libc::EMFILE));
                    break;
                }
            }
        }
        println!("EXHAUSTED {address}");
        let mut command = String::new();
        std::io::stdin().read_line(&mut command).unwrap();
        assert_eq!(command.trim(), "release");
        drop(files);
        println!("RELEASED");
        command.clear();
        std::io::stdin().read_line(&mut command).unwrap();
        assert_eq!(command.trim(), "done");
    }

    #[test]
    fn api_recovers_after_descriptor_exhaustion() {
        if std::env::var_os(CHILD_ENV).is_some() {
            exhaust_descriptors_in_child();
            return;
        }
        let mut child = OwnedChild(
            Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "server::listener::tests::api_recovers_after_descriptor_exhaustion",
                    "--nocapture",
                ])
                .env(CHILD_ENV, "1")
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap(),
        );
        let output = lines(child.0.stdout.take().unwrap());
        let errors = lines(child.0.stderr.take().unwrap());
        let address: SocketAddr = await_line(&output, "EXHAUSTED ").parse().unwrap();
        // A real connection makes accept() encounter EMFILE in the child.
        let _ = TcpStream::connect_timeout(&address, TIMEOUT);
        let error = await_line(&errors, "Dure local API listener stopped: ");
        assert!(error.contains("Too many open files"), "{error}");
        let input = child.0.stdin.as_mut().unwrap();
        writeln!(input, "release").unwrap();
        await_line(&output, "RELEASED");

        let mut client = TcpStream::connect_timeout(&address, TIMEOUT)
            .expect("the published API address must still accept connections after EMFILE");
        client.set_read_timeout(Some(TIMEOUT)).unwrap();
        client.set_write_timeout(Some(TIMEOUT)).unwrap();
        client
            .write_all(b"GET /ping HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
            .unwrap();
        let mut response = String::new();
        client.read_to_string(&mut response).unwrap();
        assert!(response.starts_with("HTTP/1.1 200"), "{response}");
        assert!(response.ends_with("available"), "{response}");
        writeln!(input, "done").unwrap();
        assert!(child.0.wait().unwrap().success());
    }
}
