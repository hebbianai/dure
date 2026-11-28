//! A provider transcript on disk: its line-delimited JSON records, in a plain
//! file or in the zstd-compressed copy (`<name>.jsonl.zst`) that Codex keeps
//! of a rollout it has not written for a while.
//!
//! Codex writes the compressed copy in place of the plain file and restores
//! the plain file before it writes the conversation again, so both hold the
//! same records at the same offsets: a cursor read from one names the same
//! record in the other. While both are there, the plain file is the one Codex
//! writes, and a walk reads it instead of the copy ([`transcript_name`]).
//!
//! Every read of a transcript's records goes through [`TranscriptFile`]. A
//! plain file reads from anywhere; a compressed copy reads only forward, so
//! each read of it decodes it from its start. A walk that reads many
//! transcripts bounds that cost with [`bounded_windows`].
use ruzstd::decoding::{
    BlockDecodingStrategy, FrameDecoder,
    errors::{FrameDecoderError, ReadFrameHeaderError},
};
use serde_json::Value;
use std::{
    collections::VecDeque,
    fs,
    io::{self, BufRead, BufReader, Read, Seek, SeekFrom},
    path::Path,
};

/// How much one step of a read takes from a decoder.
const DECODE_CHUNK_BYTES: usize = 256 * 1024;
/// How much one step of [`TranscriptFile::last_record`] reads back through a
/// plain transcript.
pub(crate) const BACKWARD_READ_BYTES: u64 = 1024 * 1024;
/// The most a [`bounded_windows`] read decodes of a compressed transcript:
/// as much as one older page reads of a plain one. A longer one keeps its
/// prefix and has no suffix. Codex compresses only rollouts it has not
/// written for days, and most are far shorter.
pub const MAX_WINDOWS_DECODED_BYTES: u64 = crate::MAX_TRANSCRIPT_PAGE_SOURCE_BYTES;

/// How a transcript file holds its records.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Encoding {
    /// As they are, appended to by their provider.
    Plain,
    /// As one zstd stream of the plain file, appended to by nothing.
    Zstd,
}

impl Encoding {
    /// Each encoding with what it adds to the name of the plain transcript.
    const NAMES: [(Self, &'static str); 2] = [(Self::Plain, ""), (Self::Zstd, ".zst")];

    /// The encoding a file name says, and the plain transcript name it holds.
    fn of(name: &str) -> Option<(Self, &str)> {
        Self::NAMES.into_iter().find_map(|(encoding, suffix)| {
            let plain = name.strip_suffix(suffix)?;
            plain.ends_with(".jsonl").then_some((encoding, plain))
        })
    }
}

/// The name of the plain transcript a walk reads `path` as: its own name for
/// a plain transcript, and the plain name for a compressed copy whose plain
/// file is not beside it. `None` for any other file.
#[must_use]
pub fn transcript_name(path: &Path) -> Option<&str> {
    let (encoding, plain) = Encoding::of(path.file_name()?.to_str()?)?;
    (encoding == Encoding::Plain || fs::symlink_metadata(path.with_file_name(plain)).is_err())
        .then_some(plain)
}

/// The last records of a transcript that a read took, from `start` up to
/// `end`, as offsets into its records. `bytes` also holds the byte before
/// `start` when there is one, which tells whether `start` starts a record.
pub(crate) struct Tail {
    pub(crate) start: u64,
    pub(crate) end: u64,
    pub(crate) bytes: Vec<u8>,
}

impl Tail {
    /// The tail's whole records and the offset of the first: a record the
    /// start of the tail cuts is left out, and so never a split code point.
    pub(crate) fn whole_records(mut self) -> (u64, Vec<u8>) {
        if self.start == 0 {
            return (0, self.bytes);
        }
        let boundary = self
            .bytes
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(self.bytes.len(), |index| index + 1);
        self.bytes.drain(..boundary);
        (self.start - 1 + boundary as u64, self.bytes)
    }
}

/// One provider transcript, opened for reading its records.
pub(crate) struct TranscriptFile {
    file: fs::File,
    metadata: fs::Metadata,
    encoding: Encoding,
}

impl TranscriptFile {
    pub(crate) fn open(path: &Path) -> io::Result<Self> {
        let file = fs::File::open(path)?;
        let metadata = file.metadata()?;
        let encoding = path
            .file_name()
            .and_then(|name| Encoding::of(name.to_str()?))
            .map_or(Encoding::Plain, |(encoding, _)| encoding);
        Ok(Self {
            file,
            metadata,
            encoding,
        })
    }

    /// The file as it was opened: whether it is a regular file, and, against
    /// a later look, whether it changed during a read.
    pub(crate) fn metadata(&self) -> &fs::Metadata {
        &self.metadata
    }

    /// The length of the records when the file tells it without a read, and
    /// then reads from anywhere in them: a plain file's.
    fn seekable_len(&self) -> Option<u64> {
        (self.encoding == Encoding::Plain).then_some(self.metadata.len())
    }

    /// The length of the records. A compressed copy is decoded to tell.
    pub(crate) fn len(&mut self) -> io::Result<u64> {
        match self.seekable_len() {
            Some(len) => Ok(len),
            None => skip(&mut self.records_from(0)?, u64::MAX),
        }
    }

    /// The records from `offset` on: none when they end before it.
    pub(crate) fn records_from(&mut self, offset: u64) -> io::Result<Box<dyn BufRead + '_>> {
        match self.encoding {
            Encoding::Plain => {
                self.file.seek(SeekFrom::Start(offset))?;
                Ok(Box::new(BufReader::new(&mut self.file)))
            }
            Encoding::Zstd => {
                self.file.seek(SeekFrom::Start(0))?;
                let mut records = BufReader::with_capacity(
                    DECODE_CHUNK_BYTES,
                    Decoded {
                        source: BufReader::with_capacity(DECODE_CHUNK_BYTES, &mut self.file),
                        frame: FrameDecoder::new(),
                        in_frame: false,
                    },
                );
                skip(&mut records, offset)?;
                Ok(Box::new(records))
            }
        }
    }

    /// The last `max_bytes` of the records that end at `end`, by default
    /// where they end, never starting before `floor`. `None` when the records
    /// end before `end`, or when reaching it would read more than
    /// `read_limit` bytes of them.
    pub(crate) fn tail(
        &mut self,
        end: Option<u64>,
        floor: u64,
        max_bytes: u64,
        read_limit: u64,
    ) -> io::Result<Option<Tail>> {
        match self.seekable_len() {
            Some(len) => seek_tail(&mut self.file, len, end, floor, max_bytes, read_limit),
            // Only the read tells where a compressed copy's records end.
            None => Ok(
                tail_of(self.records_from(0)?, 0, end, floor, max_bytes, read_limit)?
                    .filter(|tail| end.is_none_or(|end| tail.end == end)),
            ),
        }
    }

    /// The offset and length of the last whole record that ends by `end`, by
    /// default where the records end, and `matches`. Only records that hold
    /// `needle` are decoded, and `matches` sees them newest first, each with
    /// its offset.
    pub(crate) fn last_record(
        &mut self,
        end: Option<u64>,
        needle: &[u8],
        mut matches: impl FnMut(u64, &Value) -> bool,
    ) -> io::Result<Option<(u64, u64)>> {
        if !self.metadata.is_file() {
            return Err(io::Error::other(
                "provider transcript is not a regular file",
            ));
        }
        let holds = |line: &[u8]| line.windows(needle.len()).any(|window| window == needle);
        let mut found = |offset: u64, line: &[u8]| {
            serde_json::from_slice::<Value>(line)
                .is_ok_and(|value| matches(offset, &value))
                .then_some((offset, line.len() as u64))
        };
        match self.seekable_len() {
            Some(len) => last_record_back(
                &mut self.file,
                end.unwrap_or(len).min(len),
                |offset, line| {
                    if holds(line) {
                        found(offset, line)
                    } else {
                        None
                    }
                },
            ),
            None => last_record_forward(
                self.records_from(0)?.take(end.unwrap_or(u64::MAX)),
                holds,
                found,
            ),
        }
    }
}

/// Where a tail of `max_bytes` that ends at `end` starts, never before
/// `floor`.
fn tail_start(end: u64, floor: u64, max_bytes: u64) -> u64 {
    end.saturating_sub(max_bytes).max(floor.min(end))
}

/// [`TranscriptFile::tail`] of a plain `len`-byte transcript, which reads only
/// the tail and the byte before it.
pub(crate) fn seek_tail(
    file: &mut fs::File,
    len: u64,
    end: Option<u64>,
    floor: u64,
    max_bytes: u64,
    read_limit: u64,
) -> io::Result<Option<Tail>> {
    let end = end.unwrap_or(len);
    if end > len {
        return Ok(None);
    }
    let from = tail_start(end, floor, max_bytes).saturating_sub(1);
    file.seek(SeekFrom::Start(from))?;
    tail_of(file, from, Some(end), floor, max_bytes, read_limit)
}

/// The tail of the records that `records` hold from offset `from` on, read
/// forward up to `end` or where they end, whichever comes first, keeping
/// only the last `max_bytes` read and the byte before them. `None` when that
/// would read more than `read_limit` bytes (see [`TranscriptFile::tail`]).
fn tail_of(
    mut records: impl Read,
    from: u64,
    end: Option<u64>,
    floor: u64,
    max_bytes: u64,
    read_limit: u64,
) -> io::Result<Option<Tail>> {
    let keep = usize::try_from(max_bytes.saturating_add(1)).unwrap_or(usize::MAX);
    let mut kept = VecDeque::new();
    let mut position = from;
    let mut chunk = vec![0; DECODE_CHUNK_BYTES];
    loop {
        let wanted = end.map_or(chunk.len() as u64, |end| {
            end.saturating_sub(position).min(chunk.len() as u64)
        });
        if wanted == 0 {
            break;
        }
        let read = records.read(&mut chunk[..wanted as usize])?;
        if read == 0 {
            break;
        }
        position += read as u64;
        if position - from > read_limit {
            return Ok(None);
        }
        kept.extend(&chunk[..read]);
        if kept.len() > keep {
            kept.drain(..kept.len() - keep);
        }
    }
    let start = tail_start(position, floor, max_bytes);
    let kept_from = position - kept.len() as u64;
    let mut bytes = Vec::from(kept);
    bytes.drain(..(start.saturating_sub(1).saturating_sub(kept_from)) as usize);
    Ok(Some(Tail {
        start,
        end: position,
        bytes,
    }))
}

/// The last record that ends by `end` in a plain transcript and is `found`,
/// reading back from `end`: `found` sees each whole record newest first.
fn last_record_back(
    file: &mut fs::File,
    mut end: u64,
    mut found: impl FnMut(u64, &[u8]) -> Option<(u64, u64)>,
) -> io::Result<Option<(u64, u64)>> {
    // The start of the earliest record read so far, whose line began before
    // `end`: it is decoded once the step before it completes it.
    let mut carried = Vec::new();
    while end > 0 {
        let start = end.saturating_sub(BACKWARD_READ_BYTES);
        let mut bytes = vec![0; (end - start) as usize];
        file.seek(SeekFrom::Start(start))?;
        file.read_exact(&mut bytes)?;
        bytes.append(&mut carried);
        // Every line after the first line break is whole; before it, at the
        // file's start, so is the first.
        let whole_from = if start == 0 {
            0
        } else {
            match bytes.iter().position(|byte| *byte == b'\n') {
                Some(index) => index + 1,
                None => {
                    carried = bytes;
                    end = start;
                    continue;
                }
            }
        };
        let mut lines = Vec::new();
        let mut offset = start + whole_from as u64;
        for line in bytes[whole_from..].split_inclusive(|byte| *byte == b'\n') {
            lines.push((offset, line));
            offset += line.len() as u64;
        }
        if let Some(record) = lines
            .into_iter()
            .rev()
            .find_map(|(offset, line)| found(offset, line))
        {
            return Ok(Some(record));
        }
        bytes.truncate(whole_from);
        carried = bytes;
        end = start;
    }
    Ok(None)
}

/// The last record of `records` that holds the needle and is `found`, reading
/// forward: the records that hold the needle are kept, then looked at newest
/// first.
fn last_record_forward(
    mut records: impl BufRead,
    holds: impl Fn(&[u8]) -> bool,
    mut found: impl FnMut(u64, &[u8]) -> Option<(u64, u64)>,
) -> io::Result<Option<(u64, u64)>> {
    let mut held = Vec::new();
    let mut offset = 0;
    loop {
        let mut line = Vec::new();
        let read = records.read_until(b'\n', &mut line)?;
        if read == 0 {
            break;
        }
        if holds(&line) {
            held.push((offset, line));
        }
        offset += read as u64;
    }
    Ok(held
        .into_iter()
        .rev()
        .find_map(|(offset, line)| found(offset, &line)))
}

/// Reads and drops `count` bytes, or all there are when fewer: how many.
fn skip(records: &mut impl Read, count: u64) -> io::Result<u64> {
    let mut chunk = vec![0; DECODE_CHUNK_BYTES];
    let mut skipped = 0;
    while skipped < count {
        let wanted = (count - skipped).min(chunk.len() as u64) as usize;
        let read = records.read(&mut chunk[..wanted])?;
        if read == 0 {
            break;
        }
        skipped += read as u64;
    }
    Ok(skipped)
}

/// The records a zstd stream holds: each of its frames decoded in turn, and
/// its skippable frames passed over.
struct Decoded<R> {
    source: R,
    frame: FrameDecoder,
    in_frame: bool,
}

impl<R: BufRead> Read for Decoded<R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        loop {
            if self.in_frame {
                while self.frame.can_collect() < buffer.len() && !self.frame.is_finished() {
                    let wanted = buffer.len() - self.frame.can_collect();
                    self.frame
                        .decode_blocks(&mut self.source, BlockDecodingStrategy::UptoBytes(wanted))
                        .map_err(io::Error::other)?;
                }
                let read = self.frame.read(buffer)?;
                if read > 0 {
                    return Ok(read);
                }
                self.in_frame = false;
            }
            if self.source.fill_buf()?.is_empty() {
                return Ok(0);
            }
            match self.frame.init(&mut self.source) {
                Ok(()) => self.in_frame = true,
                Err(FrameDecoderError::ReadFrameHeaderError(ReadFrameHeaderError::SkipFrame {
                    length,
                    ..
                })) => {
                    let length = u64::from(length);
                    if skip(&mut self.source, length)? < length {
                        return Err(io::ErrorKind::UnexpectedEof.into());
                    }
                }
                Err(error) => return Err(io::Error::other(error)),
            }
        }
    }
}

/// The first and the last `window` bytes of a transcript's records, for a
/// walk that reads many transcripts and can spend little on each.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TranscriptWindows {
    pub prefix: String,
    /// The whole records in the last `window` bytes. `None` when they cannot
    /// be read within [`MAX_WINDOWS_DECODED_BYTES`], as in a long compressed
    /// transcript, which is read no further.
    pub suffix: Option<String>,
    /// Whether `prefix` holds all of the records.
    pub whole: bool,
}

/// [`TranscriptWindows`] of the transcript at `path`. `None` when it cannot
/// be read or holds nothing.
#[must_use]
pub fn bounded_windows(path: &Path, window: u64) -> Option<TranscriptWindows> {
    windows_within(path, window, MAX_WINDOWS_DECODED_BYTES)
}

fn windows_within(path: &Path, window: u64, read_limit: u64) -> Option<TranscriptWindows> {
    let mut file = TranscriptFile::open(path).ok()?;
    if !file.metadata().is_file() {
        return None;
    }
    // One byte past the window tells whether the prefix holds everything.
    let head = window.saturating_add(1);
    let mut prefix = Vec::new();
    let tail = match file.seekable_len() {
        // A plain transcript reads its two windows and nothing between them.
        Some(_) => {
            file.records_from(0)
                .ok()?
                .take(head)
                .read_to_end(&mut prefix)
                .ok()?;
            file.tail(None, 0, window, read_limit)
        }
        // A compressed one is read forward once, its prefix kept as it passes.
        None => tail_of(
            KeepHead {
                records: file.records_from(0).ok()?,
                head: &mut prefix,
                limit: usize::try_from(head).unwrap_or(usize::MAX),
            },
            0,
            None,
            0,
            window,
            read_limit,
        ),
    }
    .ok()?;
    if prefix.is_empty() {
        return None;
    }
    let whole = tail.is_some() && prefix.len() as u64 <= window;
    prefix.truncate(usize::try_from(window).unwrap_or(usize::MAX));
    Some(TranscriptWindows {
        prefix: String::from_utf8_lossy(&prefix).into_owned(),
        suffix: tail.map(|tail| String::from_utf8_lossy(&tail.whole_records().1).into_owned()),
        whole,
    })
}

/// Reads through `records`, keeping the first `limit` bytes read in `head`.
struct KeepHead<'a, R> {
    records: R,
    head: &'a mut Vec<u8>,
    limit: usize,
}

impl<R: Read> Read for KeepHead<'_, R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let read = self.records.read(buffer)?;
        let room = self.limit.saturating_sub(self.head.len());
        self.head.extend_from_slice(&buffer[..read.min(room)]);
        Ok(read)
    }
}

#[cfg(test)]
#[path = "transcript_file_tests.rs"]
mod tests;
