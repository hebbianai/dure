//! The phone transport for one deadline-bounded pairing exchange.

use super::{
    PairingError, PairingInvitation, MAX_RESPONSE_BYTES, PAIRING_BUDGET, PAIRING_DIAL_TIMEOUT,
};
use hmux_client::online_pairing::{exchange_io, pairing_time_remaining};
use std::io;
use std::net::{TcpStream, ToSocketAddrs};
use std::time::{Duration, Instant};

/// Connects, writes the request, and reads one newline-terminated answer.
pub(super) fn exchange(
    invitation: &PairingInvitation,
    request: &[u8],
    deadline: Instant,
) -> Result<Vec<u8>, PairingError> {
    let stream = connect(invitation, deadline)?;
    exchange_io::write_all(&stream, deadline, request).map_err(io_error)?;
    let raw = exchange_io::read_line(&stream, deadline, MAX_RESPONSE_BYTES).map_err(io_error)?;
    if raw.is_empty() {
        // Distinct from a refusal: the laptop accepted the connection and then
        // said nothing. Reporting that as "the laptop refused" would send the
        // owner to look at a QR that is fine.
        return Err(PairingError::Io {
            detail: "노트북이 아무 응답도 보내지 않고 연결을 닫았습니다".to_string(),
        });
    }
    Ok(raw)
}

fn remaining(deadline: Instant) -> Result<Duration, PairingError> {
    pairing_time_remaining(deadline).map_err(|_| PairingError::TimedOut {
        after: PAIRING_BUDGET,
    })
}

fn io_error(error: io::Error) -> PairingError {
    match error.kind() {
        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut => PairingError::TimedOut {
            after: PAIRING_BUDGET,
        },
        _ => PairingError::Io {
            detail: error.to_string(),
        },
    }
}

/// Resolves the QR's address and connects under [`PAIRING_DIAL_TIMEOUT`].
///
/// `TcpStream::connect` has no timeout at all, so a laptop that is off the
/// network parks the pairing screen for the OS's own connect timeout — minutes
/// on some networks. `connect_timeout` needs a resolved `SocketAddr`, hence the
/// explicit resolve; every resolved address is tried so a laptop published under
/// a name with both an A and an AAAA record still pairs.
fn connect(invitation: &PairingInvitation, deadline: Instant) -> Result<TcpStream, PairingError> {
    remaining(deadline)?;
    let resolved: Vec<_> = (invitation.address.as_str(), invitation.port)
        .to_socket_addrs()
        .map_err(|error| PairingError::Connect {
            detail: format!("{}: {error}", invitation.address),
        })?
        .collect();
    let mut last = None;
    for address in resolved {
        match TcpStream::connect_timeout(&address, remaining(deadline)?.min(PAIRING_DIAL_TIMEOUT)) {
            Ok(stream) => return Ok(stream),
            Err(error) => last = Some(error),
        }
    }
    remaining(deadline)?;
    Err(PairingError::Connect {
        detail: match last {
            Some(error) => format!("{}:{} — {error}", invitation.address, invitation.port),
            None => format!("{} 주소를 찾을 수 없습니다", invitation.address),
        },
    })
}
