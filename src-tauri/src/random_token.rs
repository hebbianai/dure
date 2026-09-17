/// An opaque OS-random identifier shared by desktop commands and the CLI server.
pub(crate) fn gen_token() -> std::io::Result<String> {
    let mut buf = [0u8; 16];
    getrandom::fill(&mut buf).map_err(std::io::Error::other)?;
    Ok(buf.iter().map(|b| format!("{b:02x}")).collect())
}
