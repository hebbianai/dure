//! The QR the owner scans at the desk.
//!
//! # Payload
//!
//! `hmux-pair:1?a=…&p=…&t=…&k=…&f=…&e=…&rp=2` — LAN address, port, the
//! single-use token, this laptop's SSH host key algorithm and fingerprint,
//! expiry, and the additive response-proof capability.
//!
//! Every value is chosen to need no escaping: the address is dotted decimal,
//! the port and expiry are digits, and both the token and the fingerprint are
//! base64**url**. A percent-encoder on this path would be one more thing the
//! phone half has to reimplement identically, for no benefit.
//!
//! # Rendering
//!
//! Half blocks with explicit foreground and background colours, not `█` on the
//! terminal's own background. A QR drawn with the terminal's colours is
//! inverted in a dark theme, and while many scanners cope with inversion, the
//! owner is standing at a desk trying to pair a phone — "it works on light
//! themes" is a bug report waiting to happen. Explicit black-on-white is
//! theme-independent.
//!
//! One character per module horizontally and two rows per character vertically
//! keeps a version-9 symbol inside 80 columns, which a plain `█`-per-module
//! rendering does not.

use hmux_client::online_pairing::{AUTHENTICATED_RESPONSE_PROOF_VERSION, PAIRING_PROTOCOL_VERSION};
use qrcode::{EcLevel, QrCode};

const UPPER_HALF_BLOCK: char = '▀';
/// 256-colour black and white, which survive terminals that remap the base 16.
const BLACK: &str = "\x1b[38;5;16m";
const WHITE_BACKGROUND: &str = "\x1b[48;5;231m";
const BLACK_BACKGROUND: &str = "\x1b[48;5;16m";
const WHITE: &str = "\x1b[38;5;231m";
const RESET: &str = "\x1b[0m";

/// Modules of light margin the spec requires around a symbol. Scanners rely on
/// it; a QR flush against terminal text frequently will not read.
const QUIET_ZONE: usize = 4;

pub(crate) struct PairingPayload {
    pub(crate) address: String,
    pub(crate) port: u16,
    pub(crate) token: String,
    pub(crate) host_key_algorithm: String,
    pub(crate) host_key_fingerprint_compact: String,
    pub(crate) expires_at_unix_ms: u64,
}

impl PairingPayload {
    pub(crate) fn encode(&self) -> String {
        format!(
            "hmux-pair:{}?a={}&p={}&t={}&k={}&f={}&e={}&rp={}",
            PAIRING_PROTOCOL_VERSION,
            self.address,
            self.port,
            self.token,
            self.host_key_algorithm,
            self.host_key_fingerprint_compact,
            self.expires_at_unix_ms,
            AUTHENTICATED_RESPONSE_PROOF_VERSION
        )
    }
}

/// Renders `payload` as an ANSI QR block.
///
/// Medium error correction: the symbol is read off a screen at arm's length,
/// not off a scuffed parcel, and Low would make the payload smaller at the cost
/// of the one thing that matters here — that it scans first try.
pub(crate) fn render(payload: &str) -> Result<String, String> {
    let code = QrCode::with_error_correction_level(payload.as_bytes(), EcLevel::M)
        .map_err(|error| format!("could not encode the pairing QR: {error}"))?;
    let modules = code.to_colors();
    let width = code.width();
    let padded_width = width + QUIET_ZONE * 2;
    let padded_height = width + QUIET_ZONE * 2;

    let dark = |x: usize, y: usize| -> bool {
        if x < QUIET_ZONE || y < QUIET_ZONE || x >= QUIET_ZONE + width || y >= QUIET_ZONE + width {
            return false;
        }
        modules[(y - QUIET_ZONE) * width + (x - QUIET_ZONE)] == qrcode::Color::Dark
    };

    let mut rendered = String::new();
    let mut row = 0;
    while row < padded_height {
        for column in 0..padded_width {
            let upper = dark(column, row);
            let lower = row + 1 < padded_height && dark(column, row + 1);
            rendered.push_str(if upper { BLACK } else { WHITE });
            rendered.push_str(if lower {
                BLACK_BACKGROUND
            } else {
                WHITE_BACKGROUND
            });
            rendered.push(UPPER_HALF_BLOCK);
        }
        rendered.push_str(RESET);
        rendered.push('\n');
        row += 2;
    }
    Ok(rendered)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload() -> PairingPayload {
        PairingPayload {
            address: "192.168.0.12".into(),
            port: 47_821,
            token: "dGVzdC10b2tlbi12YWx1ZS1oZXJlLTMyLWJ5dGVz".into(),
            host_key_algorithm: "ssh-ed25519".into(),
            host_key_fingerprint_compact: "abcdEFGH-_1234".into(),
            expires_at_unix_ms: 1_800_000_000_000,
        }
    }

    #[test]
    fn the_payload_carries_everything_a_phone_needs_and_needs_no_escaping() {
        let encoded = payload().encode();
        assert!(encoded.starts_with("hmux-pair:1?"));
        for expected in [
            "a=192.168.0.12",
            "p=47821",
            "t=dGVzdC10b2tlbi12YWx1ZS1oZXJlLTMyLWJ5dGVz",
            "k=ssh-ed25519",
            "f=abcdEFGH-_1234",
            "e=1800000000000",
            "rp=2",
        ] {
            assert!(
                encoded.contains(expected),
                "{expected} missing from {encoded}"
            );
        }
        assert!(
            !encoded.contains('%') && !encoded.contains(' '),
            "the payload must survive a QR unescaped: {encoded}"
        );
    }

    #[test]
    fn the_rendered_symbol_has_a_quiet_zone_and_fits_a_terminal() {
        let rendered = render(&payload().encode()).unwrap();
        let lines: Vec<&str> = rendered.lines().collect();
        let modules_per_line = lines[0].matches(UPPER_HALF_BLOCK).count();
        assert!(
            modules_per_line <= 80,
            "a QR wider than a terminal cannot be scanned: {modules_per_line} columns"
        );
        assert!(
            lines
                .first()
                .expect("the symbol has rows")
                .matches(BLACK)
                .count()
                == 0,
            "the first rendered row must be quiet zone, not modules"
        );
        assert_eq!(
            lines.len(),
            modules_per_line.div_ceil(2),
            "half-block rendering must halve the row count"
        );
    }

    #[test]
    fn a_dark_module_is_drawn_with_explicit_colours_rather_than_the_terminal_theme() {
        let rendered = render(&payload().encode()).unwrap();
        assert!(rendered.contains(BLACK_BACKGROUND) && rendered.contains(WHITE_BACKGROUND));
        assert!(
            rendered.contains(RESET),
            "each row must reset so following output is not painted white"
        );
    }
}
