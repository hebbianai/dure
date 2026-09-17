//! Lossless AV1 remux for the pinned native recorder's fragmented MP4 output.
//!
//! Sample/configuration bytes follow AV1-ISOBMFF and Matroska's V_AV1 mapping.
//! This is not a general media importer: unsupported tracks, sample layouts,
//! offsets or timing fail before an artifact is published.

use super::super::capture::MAX_ARTIFACT_BYTES;

const INVALID: &str = "browser_recording_container_invalid";
type Result<T> = std::result::Result<T, &'static str>;

#[derive(Clone, Copy)]
struct Atom<'a> {
    kind: [u8; 4],
    start: usize,
    payload: &'a [u8],
}

struct Atoms<'a> {
    remaining: &'a [u8],
    offset: usize,
}

impl<'a> Iterator for Atoms<'a> {
    type Item = Result<Atom<'a>>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.remaining.is_empty() {
            return None;
        }
        let parsed = (|| {
            let mut size = usize::try_from(u32_at(self.remaining, 0)?).map_err(|_| INVALID)?;
            let header = if size == 1 {
                size = usize::try_from(u64_at(self.remaining, 8)?).map_err(|_| INVALID)?;
                16
            } else {
                8
            };
            let bytes = self.remaining.get(..size).ok_or(INVALID)?;
            let atom = Atom {
                kind: bytes.get(4..8).ok_or(INVALID)?.try_into().unwrap(),
                start: self.offset,
                payload: bytes.get(header..).ok_or(INVALID)?,
            };
            self.remaining = &self.remaining[size..];
            self.offset = self.offset.checked_add(size).ok_or(INVALID)?;
            Ok(atom)
        })();
        if parsed.is_err() {
            self.remaining = &[];
        }
        Some(parsed)
    }
}

fn atoms(bytes: &[u8]) -> Atoms<'_> {
    Atoms {
        remaining: bytes,
        offset: 0,
    }
}

fn one<'a>(bytes: &'a [u8], kind: &[u8; 4]) -> Result<Atom<'a>> {
    let mut found = None;
    for atom in atoms(bytes) {
        let atom = atom?;
        if &atom.kind == kind && found.replace(atom).is_some() {
            return Err(INVALID);
        }
    }
    found.ok_or(INVALID)
}

fn only(bytes: &[u8], known: &[[u8; 4]]) -> Result<()> {
    for atom in atoms(bytes) {
        if !known.contains(&atom?.kind) {
            return Err(INVALID);
        }
    }
    Ok(())
}

fn u32_at(bytes: &[u8], offset: usize) -> Result<u32> {
    Ok(u32::from_be_bytes(
        bytes
            .get(offset..offset + 4)
            .ok_or(INVALID)?
            .try_into()
            .unwrap(),
    ))
}

fn u64_at(bytes: &[u8], offset: usize) -> Result<u64> {
    Ok(u64::from_be_bytes(
        bytes
            .get(offset..offset + 8)
            .ok_or(INVALID)?
            .try_into()
            .unwrap(),
    ))
}

fn word(bytes: &[u8], offset: &mut usize) -> Result<u32> {
    let value = u32_at(bytes, *offset)?;
    *offset += 4;
    Ok(value)
}

struct Movie<'a> {
    bytes: &'a [u8],
    track: u32,
    timescale: u32,
    width: u16,
    height: u16,
    config: &'a [u8],
    defaults: [u32; 3],
}

#[derive(Clone, Copy)]
struct Sample<'a> {
    bytes: &'a [u8],
    time: u64,
    key: bool,
}

impl<'a> Movie<'a> {
    fn parse(bytes: &'a [u8]) -> Result<Self> {
        if bytes.len() > MAX_ARTIFACT_BYTES {
            return Err("browser_recording_byte_limit");
        }
        one(bytes, b"ftyp")?;
        let moov = one(bytes, b"moov")?.payload;
        only(moov, &[*b"mvhd", *b"trak", *b"mvex"])?;
        let trak = one(moov, b"trak")?.payload;
        only(trak, &[*b"tkhd", *b"mdia"])?;
        let tkhd = one(trak, b"tkhd")?.payload;
        let version_offset = |bytes: &[u8]| match bytes.first() {
            Some(0) => Ok(12),
            Some(1) => Ok(20),
            _ => Err(INVALID),
        };
        let track = u32_at(tkhd, version_offset(tkhd)?)?;
        let mdia = one(trak, b"mdia")?.payload;
        let mdhd = one(mdia, b"mdhd")?.payload;
        let timescale = u32_at(mdhd, version_offset(mdhd)?)?;
        if track == 0 || timescale == 0 || one(mdia, b"hdlr")?.payload.get(8..12) != Some(b"vide") {
            return Err(INVALID);
        }
        let minf = one(mdia, b"minf")?.payload;
        let stbl = one(minf, b"stbl")?.payload;
        only(stbl, &[*b"stsc", *b"stts", *b"stco", *b"stsz", *b"stsd"])?;
        // Native recordings put all samples in movie fragments. Reject a
        // second sample authority instead of silently omitting its frames.
        for kind in [b"stsc", b"stts", b"stco"] {
            let table = one(stbl, kind)?.payload;
            if table != [0; 8] {
                return Err(INVALID);
            }
        }
        if one(stbl, b"stsz")?.payload != [0; 12] {
            return Err(INVALID);
        }
        let stsd = one(stbl, b"stsd")?.payload;
        if u32_at(stsd, 0)? != 0 || u32_at(stsd, 4)? != 1 {
            return Err(INVALID);
        }
        let av01 = one(stsd.get(8..).ok_or(INVALID)?, b"av01")?.payload;
        let width = u16::from_be_bytes(av01.get(24..26).ok_or(INVALID)?.try_into().unwrap());
        let height = u16::from_be_bytes(av01.get(26..28).ok_or(INVALID)?.try_into().unwrap());
        let config = one(av01.get(78..).ok_or(INVALID)?, b"av1C")?.payload;
        if width == 0 || height == 0 || !(4..=4096).contains(&config.len()) || config[0] != 0x81 {
            return Err(INVALID);
        }
        let trex = one(one(moov, b"mvex")?.payload, b"trex")?.payload;
        if trex.len() != 24
            || u32_at(trex, 0)? != 0
            || u32_at(trex, 4)? != track
            || u32_at(trex, 8)? != 1
        {
            return Err(INVALID);
        }
        Ok(Self {
            bytes,
            track,
            timescale,
            width,
            height,
            config,
            defaults: [u32_at(trex, 12)?, u32_at(trex, 16)?, u32_at(trex, 20)?],
        })
    }

    fn milliseconds(&self, time: u64) -> Result<u64> {
        Ok(time
            .checked_mul(1000)
            .and_then(|v| v.checked_add(u64::from(self.timescale) / 2))
            .ok_or(INVALID)?
            / u64::from(self.timescale))
    }

    /// A streaming pass retains no sample table proportional to movie length.
    /// The second pass writes exactly the samples validated by the first one.
    fn samples(&self, mut visit: impl FnMut(Sample<'a>) -> Result<()>) -> Result<f64> {
        let mut boxes = atoms(self.bytes);
        let mut origin = None;
        let mut end = 0;
        let mut previous = None;
        while let Some(atom) = boxes.next() {
            let atom = atom?;
            match &atom.kind {
                b"ftyp" | b"moov" | b"mfra" => continue,
                b"moof" => {}
                _ => return Err(INVALID),
            }
            let mdat = boxes.next().ok_or(INVALID)??;
            if mdat.kind != *b"mdat" {
                return Err(INVALID);
            }
            let traf = one(atom.payload, b"traf")?.payload;
            only(traf, &[*b"tfhd", *b"tfdt", *b"trun"])?;
            let tfhd = one(traf, b"tfhd")?.payload;
            let flags = u32_at(tfhd, 0)?;
            if flags & !0x02003a != 0 || flags & 0x020000 == 0 || u32_at(tfhd, 4)? != self.track {
                return Err(INVALID);
            }
            let mut cursor = 8;
            if flags & 2 != 0 && word(tfhd, &mut cursor)? != 1 {
                return Err(INVALID);
            }
            let mut defaults = self.defaults;
            for (index, flag) in [8, 16, 32].into_iter().enumerate() {
                if flags & flag != 0 {
                    defaults[index] = word(tfhd, &mut cursor)?;
                }
            }
            if cursor != tfhd.len() {
                return Err(INVALID);
            }
            let tfdt = one(traf, b"tfdt")?.payload;
            let mut time = match u32_at(tfdt, 0)? {
                0 if tfdt.len() == 8 => u64::from(u32_at(tfdt, 4)?),
                0x01000000 if tfdt.len() == 12 => u64_at(tfdt, 4)?,
                _ => return Err(INVALID),
            };
            if time < end {
                return Err(INVALID);
            }
            let trun = one(traf, b"trun")?.payload;
            let version_flags = u32_at(trun, 0)?;
            let flags = version_flags & 0x00ffffff;
            if version_flags >> 24 > 1
                || flags & !0x705 != 0
                || flags & 1 == 0
                || flags & 0x404 == 0x404
            {
                return Err(INVALID);
            }
            let count = u32_at(trun, 4)?;
            let mut cursor = 8;
            let offset = i64::from(word(trun, &mut cursor)? as i32);
            let absolute = i64::try_from(atom.start)
                .map_err(|_| INVALID)?
                .checked_add(offset)
                .ok_or(INVALID)?;
            let payload_start = mdat.payload.as_ptr() as usize - self.bytes.as_ptr() as usize;
            if usize::try_from(absolute).ok() != Some(payload_start)
                || count == 0
                || count as usize > mdat.payload.len()
            {
                return Err(INVALID);
            }
            let first_flags = if flags & 4 != 0 {
                word(trun, &mut cursor)?
            } else {
                defaults[2]
            };
            let mut data = mdat.payload;
            for index in 0..count {
                let duration = if flags & 0x100 != 0 {
                    word(trun, &mut cursor)?
                } else {
                    defaults[0]
                };
                let size = if flags & 0x200 != 0 {
                    word(trun, &mut cursor)?
                } else {
                    defaults[1]
                } as usize;
                let sample_flags = if flags & 0x400 != 0 {
                    word(trun, &mut cursor)?
                } else if index == 0 {
                    first_flags
                } else {
                    defaults[2]
                };
                if duration == 0 || size == 0 {
                    return Err(INVALID);
                }
                let sample = data.get(..size).ok_or(INVALID)?;
                let key = sample_flags & 0x10000 == 0;
                if origin.is_none() && !key {
                    return Err(INVALID);
                }
                let base = *origin.get_or_insert(time);
                let relative = time.checked_sub(base).ok_or(INVALID)?;
                let milliseconds = self.milliseconds(relative)?;
                if previous.is_some_and(|old| milliseconds <= old) {
                    return Err(INVALID);
                }
                previous = Some(milliseconds);
                visit(Sample {
                    bytes: sample,
                    time: milliseconds,
                    key,
                })?;
                data = &data[size..];
                time = time.checked_add(u64::from(duration)).ok_or(INVALID)?;
            }
            if cursor != trun.len() || !data.is_empty() {
                return Err(INVALID);
            }
            end = time;
        }
        let ticks = end.checked_sub(origin.ok_or(INVALID)?).ok_or(INVALID)?;
        Ok(ticks as f64 * 1000.0 / f64::from(self.timescale))
    }
}

fn identifier(id: u32) -> Vec<u8> {
    let bytes = id.to_be_bytes();
    bytes[bytes.iter().position(|byte| *byte != 0).unwrap()..].to_vec()
}

fn element(out: &mut Vec<u8>, id: u32, bytes: &[u8]) -> Result<()> {
    let id = identifier(id);
    let size = bytes.len() as u64;
    let width = (1..=8)
        .find(|width| size < (1u64 << (width * 7)) - 1)
        .ok_or(INVALID)?;
    if out
        .len()
        .checked_add(id.len() + width + bytes.len())
        .ok_or(INVALID)?
        > MAX_ARTIFACT_BYTES
    {
        return Err("browser_recording_byte_limit");
    }
    out.extend(id);
    let encoded = (size | (1u64 << (width * 7))).to_be_bytes();
    out.extend_from_slice(&encoded[8 - width..]);
    out.extend_from_slice(bytes);
    Ok(())
}

fn uint(out: &mut Vec<u8>, id: u32, value: u64) -> Result<()> {
    let bytes = value.to_be_bytes();
    element(
        out,
        id,
        &bytes[bytes.iter().position(|byte| *byte != 0).unwrap_or(7)..],
    )
}

fn seek_head(info: usize, tracks: usize, cues: usize) -> Result<Vec<u8>> {
    let mut entries = Vec::new();
    for (id, offset) in [(0x1549a966, info), (0x1654ae6b, tracks), (0x1c53bb6b, cues)] {
        let mut entry = Vec::new();
        element(&mut entry, 0x53ab, &identifier(id))?;
        // Fixed-width offsets let us fill this header without shifting data.
        element(&mut entry, 0x53ac, &(offset as u64).to_be_bytes())?;
        element(&mut entries, 0x4dbb, &entry)?;
    }
    let mut header = Vec::new();
    element(&mut header, 0x114d9b74, &entries)?;
    Ok(header)
}

pub(super) fn webm(bytes: &[u8]) -> Result<Vec<u8>> {
    let movie = Movie::parse(bytes)?;
    let duration = movie.samples(|_| Ok(()))?;
    let mut segment = seek_head(0, 0, 0)?;
    let info_offset = segment.len();
    let mut info = Vec::new();
    uint(&mut info, 0x2ad7b1, 1_000_000)?;
    element(&mut info, 0x4489, &duration.to_be_bytes())?;
    element(&mut info, 0x4d80, b"Dure")?;
    element(&mut info, 0x5741, b"Dure")?;
    element(&mut segment, 0x1549a966, &info)?;
    let tracks_offset = segment.len();
    let mut track = Vec::new();
    for (id, value) in [(0xd7, 1), (0x73c5, 1), (0x83, 1), (0x9c, 0)] {
        uint(&mut track, id, value)?;
    }
    element(&mut track, 0x86, b"V_AV1")?;
    element(&mut track, 0x63a2, movie.config)?;
    let mut video = Vec::new();
    uint(&mut video, 0xb0, u64::from(movie.width))?;
    uint(&mut video, 0xba, u64::from(movie.height))?;
    element(&mut track, 0xe0, &video)?;
    let mut tracks = Vec::new();
    element(&mut tracks, 0xae, &track)?;
    element(&mut segment, 0x1654ae6b, &tracks)?;
    let mut cluster = Vec::new();
    let mut cluster_time = 0;
    let mut cues = Vec::new();
    movie.samples(|sample| {
        if cluster.is_empty() || sample.key || sample.time - cluster_time > i16::MAX as u64 {
            if !cluster.is_empty() {
                element(&mut segment, 0x1f43b675, &cluster)?;
                cluster.clear();
            }
            cluster_time = sample.time;
            if sample.key {
                let mut positions = Vec::new();
                uint(&mut positions, 0xf7, 1)?;
                uint(&mut positions, 0xf1, segment.len() as u64)?;
                let mut cue = Vec::new();
                uint(&mut cue, 0xb3, sample.time)?;
                element(&mut cue, 0xb7, &positions)?;
                element(&mut cues, 0xbb, &cue)?;
            }
            uint(&mut cluster, 0xe7, cluster_time)?;
        }
        let relative = (sample.time - cluster_time) as i16;
        let mut block = vec![
            0x81,
            (relative >> 8) as u8,
            relative as u8,
            if sample.key { 0x80 } else { 0 },
        ];
        block.extend_from_slice(sample.bytes);
        element(&mut cluster, 0xa3, &block)
    })?;
    element(&mut segment, 0x1f43b675, &cluster)?;
    let cues_offset = segment.len();
    element(&mut segment, 0x1c53bb6b, &cues)?;
    let seek = seek_head(info_offset, tracks_offset, cues_offset)?;
    segment[..seek.len()].copy_from_slice(&seek);
    let mut header = Vec::new();
    for (id, value) in [
        (0x4286, 1),
        (0x42f7, 1),
        (0x42f2, 4),
        (0x42f3, 8),
        (0x4287, 4),
        (0x4285, 2),
    ] {
        uint(&mut header, id, value)?;
    }
    element(&mut header, 0x4282, b"webm")?;
    let mut result = Vec::new();
    element(&mut result, 0x1a45dfa3, &header)?;
    element(&mut result, 0x18538067, &segment)?;
    Ok(result)
}

#[cfg(test)]
mod tests;
