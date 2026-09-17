//! Socket boundary for the laptop half of one online pairing exchange.

use super::*;
use hmux_client::online_pairing::exchange_io;
use std::net::TcpStream;

pub(super) fn handle_connection<I: AuthorizedKeyInstaller>(
    stream: TcpStream,
    session: &mut PairingSession,
    hosts: &[InventoryHost],
    terms: PairingTerms<'_>,
    installer: &I,
    registry_path: &Path,
    deadline: Instant,
) -> Result<Option<PairedAnswer>, String> {
    stream
        .set_nonblocking(false)
        .map_err(|error| error.to_string())?;
    let raw = exchange_io::read_line(
        &stream,
        deadline.min(Instant::now() + CONNECTION_TIMEOUT),
        MAX_REQUEST_BYTES,
    )
    .map_err(|error| error.to_string())?;

    let response = match verify_request(session, &raw, SystemTime::now(), deadline) {
        Err(response) => response,
        Ok(verified) => {
            // Only a token-authenticated request may wait for the destructive
            // registry lease. Refresh time after the wait so an expired QR can
            // never start mutating the fleet with its earlier accept time.
            match DeviceRegistry::acquire(registry_path.to_path_buf(), Some(verified.deadline)) {
                Ok(mut registry) => complete_after_lease(
                    session,
                    hosts,
                    terms,
                    installer,
                    &mut registry,
                    verified,
                    SystemTime::now(),
                ),
                Err(_) if pairing_time_remaining(deadline).is_err() => PairingResponse::refused(
                    PAIRING_DEADLINE_ELAPSED,
                    "pairing timed out while waiting for the device registry; nothing was installed",
                ),
                Err(error) => registry_unwritable_response(&error),
            }
        }
    };
    let mut encoded = serde_json::to_vec(&response).map_err(|error| error.to_string())?;
    encoded.push(b'\n');
    // Reporting a timed-out mutation may finish after its deadline; it never
    // extends the time available for installing a key.
    exchange_io::write_all(&stream, Instant::now() + CONNECTION_TIMEOUT, &encoded)
        .map_err(|error| error.to_string())?;
    let _ = stream.shutdown(std::net::Shutdown::Write);
    match response {
        PairingResponse::Paired(answer) => Ok(Some(answer)),
        PairingResponse::Refused(refusal) => {
            Err(format!("{} ({})", refusal.reason, refusal.detail))
        }
    }
}
