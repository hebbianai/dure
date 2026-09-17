#![cfg(feature = "external-proof")]

use std::time::{Duration, Instant};

use terminal_core_ghostty_proof::{Core, NativeHistoryAnchor, NativeHistoryArchive};

const COLUMNS: u16 = 80;
const VIEWPORT_ROWS: u16 = 24;
const SHORT_HISTORY_ROWS: usize = 100_000;
const LONG_HISTORY_ROWS: usize = 1_000_000;

#[derive(Debug)]
struct Characterization {
    projection_wall_time: Duration,
    projected_rows: usize,
    visited_rows: usize,
}

fn terminal_with_history(logical_rows: usize) -> Core {
    // Ghostty's line limit is translated to a page-allocation budget and is
    // intentionally approximate. Leave enough room for the requested rows.
    let history_limit = logical_rows.saturating_mul(4).saturating_add(128);
    let mut core = Core::new(COLUMNS, VIEWPORT_ROWS, history_limit).unwrap();
    let mut output = Vec::with_capacity(logical_rows * 3);
    for _ in 0..logical_rows {
        output.extend_from_slice(b"x\r\n");
    }
    core.write(&output).unwrap();
    let observation = core.observe().unwrap();
    let minimum_scrollback = logical_rows.saturating_sub(usize::from(VIEWPORT_ROWS));
    assert!(
        observation.scrollback_rows >= minimum_scrollback,
        "requested {logical_rows} rows but retained {observation:?}"
    );
    core
}

fn project_from_tracked_anchor(logical_rows: usize) -> Characterization {
    let core = terminal_with_history(logical_rows);
    let before = core.observe().unwrap();
    let anchor_row = before
        .scrollback_rows
        .saturating_sub(2 * usize::from(VIEWPORT_ROWS));
    let anchor = core.track_screen_row(anchor_row).unwrap();

    let projection_started = Instant::now();
    let projection = anchor
        .project_rows(COLUMNS, usize::from(VIEWPORT_ROWS))
        .unwrap();
    let projection_wall_time = projection_started.elapsed();

    Characterization {
        projection_wall_time,
        projected_rows: projection.rows.len(),
        visited_rows: projection.visited_rows,
    }
}

fn bounded_growth(short: Duration, long: Duration) -> bool {
    const MAX_SCALE: u128 = 8;
    const FIXED_NOISE_BUDGET: Duration = Duration::from_millis(1);
    long.as_nanos()
        <= short
            .as_nanos()
            .saturating_mul(MAX_SCALE)
            .saturating_add(FIXED_NOISE_BUDGET.as_nanos())
}

#[test]
fn retained_prefix_is_encoded_as_opaque_native_page_records() {
    let mut core = Core::new_history_supplier(COLUMNS, 4, 20_000).unwrap();
    let mut output = Vec::new();
    for index in 0..256 {
        output.extend_from_slice(format!("H{index:06}\r\n").as_bytes());
    }
    core.write(&output).unwrap();

    let offer = core
        .next_history_prefix_offer(64, 8_192)
        .unwrap()
        .expect("history above the hot reserve must produce one retained prefix");
    assert_eq!(
        offer.encode_native_archive(1, 64).unwrap_err().0,
        -3,
        "native PAGE encoding must refuse the caller's byte ceiling in one bounded pass"
    );
    let archive = offer.encode_native_archive(1, 4 * 1024 * 1024).unwrap();

    assert_eq!(&archive.bytes[..8], b"GHPAGE01");
    assert_eq!(archive.first_logical_line_id, 1);
    assert!(archive.next_logical_line_id > archive.first_logical_line_id);
    assert_eq!(archive.physical_rows, offer.physical_rows);
    assert!(archive.bytes.len() > archive.physical_rows);
    let page_count = u32::from_le_bytes(archive.bytes[12..16].try_into().unwrap());
    let first_page_rows = u16::from_le_bytes(archive.bytes[74..76].try_into().unwrap());
    assert!(page_count > 1);
    assert!(first_page_rows <= 4 * 1024 / COLUMNS);

    let page_count = usize::try_from(page_count).unwrap();
    let metadata_len = 48 + page_count * 32 + archive.physical_rows * 32;
    let mut gapped = archive.bytes.clone();
    gapped.insert(metadata_len, 0);
    for page_index in 0..page_count {
        let offset = 48 + page_index * 32;
        let record_offset = u64::from_le_bytes(gapped[offset..offset + 8].try_into().unwrap());
        gapped[offset..offset + 8].copy_from_slice(&(record_offset + 1).to_le_bytes());
    }
    assert!(
        NativeHistoryArchive::inspect_chunk(&gapped).is_err(),
        "native PAGE records must cover the payload with no unclaimed gap"
    );

    let mut overlapping = archive.bytes.clone();
    let first_record_offset = overlapping[48..56].to_vec();
    let first_record_len = overlapping[56..64].to_vec();
    overlapping[80..88].copy_from_slice(&first_record_offset);
    overlapping[88..96].copy_from_slice(&first_record_len);
    assert!(
        NativeHistoryArchive::inspect_chunk(&overlapping).is_err(),
        "native PAGE record ranges must neither overlap nor duplicate"
    );

    let mut trailing = archive.bytes.clone();
    trailing.push(0);
    assert!(
        NativeHistoryArchive::inspect_chunk(&trailing).is_err(),
        "native PAGE records must cover the complete payload"
    );

    let mut retained = NativeHistoryArchive::new().unwrap();
    retained.append(&archive.bytes).unwrap();
    let bounds = retained.bounds().unwrap();
    assert_eq!(bounds.first_logical_line_id, archive.first_logical_line_id);
    assert_eq!(bounds.next_logical_line_id, archive.next_logical_line_id);
    assert_eq!(bounds.physical_rows, archive.physical_rows);

    let mut corrupt = archive.bytes.clone();
    *corrupt.last_mut().unwrap() ^= 0xff;
    assert!(retained.append(&corrupt).is_err());
    assert_eq!(retained.bounds().unwrap(), bounds);

    let projected = retained
        .project(
            NativeHistoryAnchor {
                logical_line_id: archive.first_logical_line_id,
                logical_cell_offset: 0,
            },
            COLUMNS - 1,
            8,
        )
        .unwrap();
    assert_eq!(projected.rows.len(), 8);
    assert_eq!(projected.rows[0].anchor.logical_line_id, 1);
    assert_eq!(projected.rows[0].anchor.logical_cell_offset, 0);
    let first_text = projected.rows[0]
        .row
        .cells
        .iter()
        .map(|cell| cell.text.as_str())
        .collect::<String>();
    assert!(first_text.starts_with("H000000"), "{first_text:?}");
    assert!(projected.work.index_nodes_visited <= 128, "{projected:?}");
    assert!(projected.work.chunks_visited <= 4, "{projected:?}");
    assert!(projected.work.cells_visited <= 12 * 1_024, "{projected:?}");
}

#[test]
fn native_archive_projects_a_128k_soft_wrapped_line_with_bounded_work() {
    const SOURCE_COLUMNS: u16 = 1_024;
    const PROJECTED_ROWS: usize = 8;

    let mut core = Core::new_history_supplier(SOURCE_COLUMNS, 4, 20_000).unwrap();
    let mut output = vec![b'x'; 128 * 1_024];
    output.extend_from_slice(b"\r\n");
    for index in 0..32 {
        output.extend_from_slice(format!("TAIL{index:02}\r\n").as_bytes());
    }
    core.write(&output).unwrap();

    let offer = core
        .next_history_prefix_offer(8, 8_192)
        .unwrap()
        .expect("the long logical line must become an immutable cold prefix");
    let chunk = offer.encode_native_archive(1, 4 * 1024 * 1024).unwrap();
    let mut archive = NativeHistoryArchive::new().unwrap();
    archive.append(&chunk.bytes).unwrap();

    let stationary = archive.move_rows(None, SOURCE_COLUMNS, 0, 128).unwrap();
    assert_eq!(stationary.anchor, None);
    assert_eq!(stationary.moved_rows, 0);

    let movement = archive
        .move_rows(
            Some(NativeHistoryAnchor {
                logical_line_id: 1,
                logical_cell_offset: 0,
            }),
            SOURCE_COLUMNS,
            64,
            128,
        )
        .unwrap();
    assert_eq!(movement.moved_rows, 64);
    assert_eq!(
        movement.anchor,
        Some(NativeHistoryAnchor {
            logical_line_id: 1,
            logical_cell_offset: 64 * u32::from(SOURCE_COLUMNS),
        })
    );
    assert!(movement.work.index_nodes_visited <= 64, "{movement:?}");
    assert_eq!(movement.work.chunks_visited, 0, "{movement:?}");
    assert_eq!(movement.work.cells_visited, 0, "{movement:?}");

    let reflowed_movement = archive
        .move_rows(movement.anchor, SOURCE_COLUMNS - 1, 1, 128)
        .unwrap();
    assert_eq!(reflowed_movement.moved_rows, 1);
    assert_eq!(
        reflowed_movement.anchor,
        Some(NativeHistoryAnchor {
            logical_line_id: 1,
            logical_cell_offset: 64 * u32::from(SOURCE_COLUMNS) + u32::from(SOURCE_COLUMNS - 1),
        }),
        "a stable logical marker need not be aligned to the resized column count"
    );

    for (columns, logical_cell_offset) in [
        (SOURCE_COLUMNS, 0),
        (SOURCE_COLUMNS, u32::from(SOURCE_COLUMNS)),
        (SOURCE_COLUMNS - 1, 0),
    ] {
        let projection = archive
            .project(
                NativeHistoryAnchor {
                    logical_line_id: 1,
                    logical_cell_offset,
                },
                columns,
                PROJECTED_ROWS,
            )
            .unwrap();
        assert_eq!(projection.rows.len(), PROJECTED_ROWS);
        assert_eq!(projection.rows[0].anchor.logical_line_id, 1);
        assert_eq!(
            projection.rows[0].anchor.logical_cell_offset,
            logical_cell_offset
        );
        assert!(projection.work.index_nodes_visited <= 128, "{projection:?}");
        assert!(projection.work.chunks_visited <= 16, "{projection:?}");
        assert!(
            projection.work.cells_visited <= 64 * 1_024,
            "{projection:?}"
        );
    }
}

#[test]
fn tracked_anchor_projection_visits_only_the_bounded_viewport() {
    let short = project_from_tracked_anchor(SHORT_HISTORY_ROWS);
    let long = project_from_tracked_anchor(LONG_HISTORY_ROWS);

    eprintln!("short={short:?} long={long:?}");
    assert_eq!(long.projected_rows, usize::from(VIEWPORT_ROWS));
    assert_eq!(short.visited_rows, usize::from(VIEWPORT_ROWS));
    assert_eq!(long.visited_rows, usize::from(VIEWPORT_ROWS));
    let projection_bounded = bounded_growth(short.projection_wall_time, long.projection_wall_time);
    assert!(
        projection_bounded,
        "history-linear projection detected: short={short:?} long={long:?}"
    );
}
