#![cfg(feature = "external-proof")]

use sha2::{Digest, Sha256};
use terminal_core_ghostty_proof::{Core, Format};

#[test]
fn formatting_preserves_history_styles_modes_and_fresh_mutations() {
    let mut core = Core::new(40, 6, 256).unwrap();
    let phases: [&[u8]; 5] = [
        b"",
        "old history\r\n\x1b[31mred 한e\u{301}👩‍💻\x1b[0m\r\n\x1b]8;;https://example.invalid\x1b\\link\x1b]8;;\x1b\\\r\n3\r\n4\r\n5\r\n6\r\n7".as_bytes(),
        b"\x1b[?1049h\x1b[?1h\x1b[?2004h\x1b[?25l\x1b[2;3Halternate",
        b"\x1b[?1049l\r\nlatest mutation",
        b"\x1b[2J\x1b[Hfresh",
    ];
    // Captured from the original formatter for the pinned Ghostty revision.
    let expected = [
        [
            (
                0,
                "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            ),
            (
                41,
                "a9c8971fd1d5eb6888d4a860d7e4b284d288b5e33bf460b55cbaa9414937dcab",
            ),
        ],
        [
            (
                48,
                "3131c86e1e06bcb7bb9b4c36317d14d5a2fa223ebef113f36de49f89acd4ac6e",
            ),
            (
                113,
                "d9b3da2a31d3b1b8668dec1b48b62a8292b0e726c3e728b2eff9a08766ab8130",
            ),
        ],
        [
            (
                12,
                "350a686df6d9ff09b282c6db69567d757dcb9cd37bcd1d1b184dcf00878cdf30",
            ),
            (
                82,
                "f7248dc0feb720e534a79ef9244c8dde346876ed975b7aba048e933b0d16aa96",
            ),
        ],
        [
            (
                64,
                "69c9a2370340836998bca9822075a0b354514e41cfe929f4c213610356cfa211",
            ),
            (
                150,
                "3899470572356dc219c594eee388c0c81d1dbf73beb343ae90879b73876bde2f",
            ),
        ],
        [
            (
                44,
                "291d4833d5ab4f7714b6b9f3d5dc1132ef83db19f32998a498685b1fdd8e8d1b",
            ),
            (
                124,
                "9fb0fdccec9f8354f294d51ae290140c28975e88b63745612d1ed713d32a6f3a",
            ),
        ],
    ];
    for (phase, input) in phases.into_iter().enumerate() {
        core.write(input).unwrap();
        for (index, format) in [Format::Plain, Format::StyledVt].into_iter().enumerate() {
            let first = core.format(format).unwrap();
            assert_eq!(first, core.format(format).unwrap());
            assert_eq!(
                (first.len(), format!("{:x}", Sha256::digest(&first))),
                (
                    expected[phase][index].0,
                    expected[phase][index].1.to_owned()
                ),
                "phase {phase}, {format:?}",
            );
        }
    }
}
