use super::*;

// Disposable red/blue page recording produced by the pinned Chromium155
// recorder. Decoder evidence and its immutable hash are recorded on #583.
static NATIVE: &[u8] = include_bytes!("fixtures/pinned-av1.mp4");

#[test]
fn native_samples_keep_their_configuration_timing_and_bytes() {
    let movie = Movie::parse(NATIVE).unwrap();
    assert_eq!(
        (movie.width, movie.height, movie.timescale),
        (1280, 632, 10000)
    );
    let mut samples = Vec::new();
    let duration = movie
        .samples(|sample| {
            samples.push(sample);
            Ok(())
        })
        .unwrap();
    assert_eq!(duration, 663.2);
    assert_eq!(
        samples.iter().map(|sample| sample.time).collect::<Vec<_>>(),
        [0, 110, 210, 269, 402, 502, 563]
    );
    assert_eq!(
        samples.iter().map(|sample| sample.key).collect::<Vec<_>>(),
        [true, false, false, false, false, false, false]
    );
    let output = webm(NATIVE).unwrap();
    let root = ebml(&output);
    assert_eq!(
        root.iter().map(|row| row.0).collect::<Vec<_>>(),
        [0x1a45dfa3, 0x18538067]
    );
    assert_eq!(child(root[0].1, 0x4282), b"webm");
    let segment = root[1].1;
    let entries = ebml(segment);
    let track = child(child(segment, 0x1654ae6b), 0xae);
    assert_eq!(child(track, 0x63a2), movie.config);
    assert_eq!(child(track, 0x86), b"V_AV1");
    let info = child(segment, 0x1549a966);
    assert_eq!(
        f64::from_be_bytes(child(info, 0x4489).try_into().unwrap()),
        duration
    );
    let cluster = child(segment, 0x1f43b675);
    let blocks = ebml(cluster)
        .into_iter()
        .filter(|row| row.0 == 0xa3)
        .map(|row| row.1)
        .collect::<Vec<_>>();
    assert_eq!(blocks.len(), samples.len());
    for (block, sample) in blocks.iter().zip(samples) {
        assert_eq!(block[0], 0x81);
        assert_eq!(
            u16::from_be_bytes(block[1..3].try_into().unwrap()) as u64,
            sample.time
        );
        assert_eq!(block[3] & 0x80 != 0, sample.key);
        assert_eq!(&block[4..], sample.bytes);
    }
    let seeks = ebml(child(segment, 0x114d9b74));
    assert_eq!(seeks.len(), 3);
    for (_, seek, _) in seeks {
        let id = integer(child(seek, 0x53ab));
        let offset = integer(child(seek, 0x53ac)) as usize;
        assert!(entries.iter().any(|row| row.0 == id && row.2 == offset));
    }
    let cue = child(child(segment, 0x1c53bb6b), 0xbb);
    let position = integer(child(child(cue, 0xb7), 0xf1)) as usize;
    assert_eq!(integer(child(cue, 0xb3)), 0);
    assert!(
        entries
            .iter()
            .any(|row| row.0 == 0x1f43b675 && row.2 == position)
    );
    retain("native", NATIVE, &output);
}

#[test]
fn multiple_fragments_and_long_nonkey_intervals_keep_valid_cluster_and_cue_offsets() {
    let moof = one(NATIVE, b"moof").unwrap();
    let mfra = one(NATIVE, b"mfra").unwrap();
    let traf = one(moof.payload, b"traf").unwrap();
    let tfdt = one(traf.payload, b"tfdt").unwrap();
    let trun = one(traf.payload, b"trun").unwrap();
    let offset = |bytes: &[u8]| bytes.as_ptr() as usize - NATIVE.as_ptr() as usize;
    let mut fragment = NATIVE[moof.start..mfra.start].to_vec();
    let time_offset = offset(tfdt.payload) + 4 - moof.start;
    fragment[time_offset..time_offset + 8].copy_from_slice(&400_000u64.to_be_bytes());
    let sequence_offset = offset(one(moof.payload, b"mfhd").unwrap().payload) + 4 - moof.start;
    fragment[sequence_offset..sequence_offset + 4].copy_from_slice(&2u32.to_be_bytes());
    let mut multiple = NATIVE[..mfra.start].to_vec();
    multiple.extend(fragment);
    let output = webm(&multiple).unwrap();
    let segment = child(&output, 0x18538067);
    let entries = ebml(segment);
    let cues = ebml(child(segment, 0x1c53bb6b));
    assert_eq!(cues.len(), 2);
    for ((_, cue, _), time) in cues.iter().zip([0, 40_000]) {
        assert_eq!(integer(child(cue, 0xb3)), time);
        let position = integer(child(child(cue, 0xb7), 0xf1)) as usize;
        let cluster = entries
            .iter()
            .find(|row| row.0 == 0x1f43b675 && row.2 == position)
            .unwrap();
        assert_eq!(integer(child(cluster.1, 0xe7)), time);
        assert_ne!(child(cluster.1, 0xa3)[3] & 0x80, 0);
    }
    retain("fragments", &multiple, &output);
    let mut long = NATIVE.to_vec();
    let duration = offset(trun.payload) + 16;
    long[duration..duration + 4].copy_from_slice(&400_000u32.to_be_bytes());
    let output = webm(&long).unwrap();
    let segment = child(&output, 0x18538067);
    let entries = ebml(segment);
    let clusters = entries
        .iter()
        .filter(|row| row.0 == 0x1f43b675)
        .collect::<Vec<_>>();
    assert_eq!(clusters.len(), 2);
    assert_eq!(integer(child(clusters[1].1, 0xe7)), 40_000);
    assert_eq!(child(clusters[1].1, 0xa3)[3] & 0x80, 0);
    assert_eq!(ebml(child(segment, 0x1c53bb6b)).len(), 1);
    retain("long-interval", &long, &output);
}

fn retain(name: &str, native: &[u8], webm: &[u8]) {
    let root = tempfile::Builder::new()
        .prefix("dure-recording-remux-")
        .tempdir()
        .unwrap()
        .keep();
    std::fs::write(root.join("native.mp4"), native).unwrap();
    std::fs::write(root.join("converted.webm"), webm).unwrap();
    println!(
        "BROWSER_RECORDING_REMUX_FIXTURE name={name} root={}",
        root.display()
    );
}

#[test]
fn truncation_and_foreign_or_unbounded_sample_layouts_fail_closed() {
    let complete_data = atoms(NATIVE)
        .map(|row| row.unwrap())
        .find(|row| row.kind == *b"mfra")
        .unwrap()
        .start;
    for end in 0..NATIVE.len() {
        assert_eq!(
            webm(&NATIVE[..end]).is_ok(),
            end == complete_data,
            "prefix {end}"
        );
    }
    let moof = one(NATIVE, b"moof").unwrap();
    let traf = one(moof.payload, b"traf").unwrap();
    let tfhd = one(traf.payload, b"tfhd").unwrap();
    let trun = one(traf.payload, b"trun").unwrap();
    let mdhd = one(
        one(
            one(one(NATIVE, b"moov").unwrap().payload, b"trak")
                .unwrap()
                .payload,
            b"mdia",
        )
        .unwrap()
        .payload,
        b"mdhd",
    )
    .unwrap();
    let offset = |bytes: &[u8]| bytes.as_ptr() as usize - NATIVE.as_ptr() as usize;
    for (position, value) in [
        (0, u32::MAX),
        (offset(tfhd.payload) + 4, 2),
        (offset(tfhd.payload), 0x00020021), // Unsupported external base offset.
        (offset(trun.payload) + 4, u32::MAX),
        (offset(trun.payload) + 8, u32::MAX),
        (offset(trun.payload) + 16, 0), // Zero sample duration.
        (offset(trun.payload) + 20, u32::MAX),
        (offset(trun.payload), 0x01000b05), // AV1 composition offsets forbidden.
        (offset(mdhd.payload) + 20, 0),
    ] {
        let mut broken = NATIVE.to_vec();
        broken[position..position + 4].copy_from_slice(&value.to_be_bytes());
        assert!(webm(&broken).is_err(), "offset {position}, value {value}");
    }
}

#[test]
fn large_ebml_elements_respect_the_shared_artifact_bound() {
    let mut output = vec![0; MAX_ARTIFACT_BYTES - 4];
    assert_eq!(
        element(&mut output, 0xa3, &[1; 4]),
        Err("browser_recording_byte_limit")
    );
    assert_eq!(output.len(), MAX_ARTIFACT_BYTES - 4);
}

// Independent EBML reader for offsets and payloads; it does not reuse the muxer.
fn ebml(bytes: &[u8]) -> Vec<(u64, &[u8], usize)> {
    let mut offset = 0;
    let mut elements = Vec::new();
    while offset < bytes.len() {
        let start = offset;
        let id_width = bytes[offset].leading_zeros() as usize + 1;
        let id = integer(&bytes[offset..offset + id_width]);
        offset += id_width;
        let width = bytes[offset].leading_zeros() as usize + 1;
        let length = integer(&bytes[offset..offset + width]) & ((1u64 << (width * 7)) - 1);
        offset += width;
        elements.push((id, &bytes[offset..offset + length as usize], start));
        offset += length as usize;
    }
    elements
}

fn child(bytes: &[u8], id: u64) -> &[u8] {
    ebml(bytes).into_iter().find(|row| row.0 == id).unwrap().1
}

fn integer(bytes: &[u8]) -> u64 {
    bytes
        .iter()
        .fold(0, |value, byte| (value << 8) | u64::from(*byte))
}
