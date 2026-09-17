use super::*;
use std::io::{Read as _, Write as _};
use std::net::TcpListener;

#[test]
fn slow_response_bytes_do_not_restart_the_phone_budget() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let mut invitation = parse_invitation(&payload()).unwrap();
    invitation.address = "127.0.0.1".into();
    invitation.port = listener.local_addr().unwrap().port();
    let laptop = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut request = [0];
        stream.read_exact(&mut request).unwrap();
        for _ in 0..20 {
            if stream.write_all(b" ").is_err() {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let _ = stream.write_all(b"\n");
    });
    let result = exchange::exchange(&invitation, b"\n", Instant::now() + Duration::from_secs(1));
    laptop.join().unwrap();
    assert!(
        matches!(result, Err(PairingError::TimedOut { .. })),
        "a late response was accepted: {result:?}"
    );
}

#[test]
fn host_deadline_refusal_is_the_same_timeout_the_phone_reports() {
    let raw = serde_json::to_vec(&PairingResponse::refused(
        hmux_client::online_pairing::PAIRING_DEADLINE_ELAPSED,
        "pairing timed out; partial installs remain revocable",
    ))
    .unwrap();
    let result = read_current_answer(&raw, b"nonce", TOKEN);
    assert!(
        matches!(result, Err(PairingError::TimedOut { .. })),
        "the same deadline was reported differently: {result:?}"
    );
}
