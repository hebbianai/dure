//! Called on the main thread, only after the user chooses Paste. UIKit owns
//! the cross-application paste permission prompt; no clipboard is polled.
use base64::Engine as _;
use objc2_foundation::NSString;
use objc2_ui_kit::UIPasteboard;
use serde::Serialize;

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ClipboardContent {
    Text { text: String },
    Image { image: ClipboardImage },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardImage {
    data_b64: String,
    ext: &'static str,
}

pub fn read() -> Result<Option<ClipboardContent>, String> {
    let _main =
        objc2::MainThreadMarker::new().ok_or("Clipboard access requires the main thread")?;
    let board = UIPasteboard::generalPasteboard();
    for (kind, ext) in [("public.png", "png"), ("public.jpeg", "jpg")] {
        if let Some(data) = board.dataForPasteboardType(&NSString::from_str(kind)) {
            return image(&data, ext).map(Some);
        }
    }
    // SAFETY: the main-thread marker above confines UIKit's non-atomic properties.
    if let Some(value) = unsafe { board.image() } {
        let data = value
            .png_representation()
            .ok_or("The clipboard image could not be read")?;
        return image(&data, "png").map(Some);
    }
    // SAFETY: this read uses the same main-thread-confined pasteboard.
    Ok(
        unsafe { board.string() }.map(|text| ClipboardContent::Text {
            text: text.to_string(),
        }),
    )
}

fn image(data: &objc2_foundation::NSData, ext: &'static str) -> Result<ClipboardContent, String> {
    if data.length() > 10 * 1024 * 1024 {
        return Err("Images must be 10 MB or smaller".into());
    }
    Ok(ClipboardContent::Image {
        image: ClipboardImage {
            data_b64: base64::engine::general_purpose::STANDARD.encode(data.to_vec()),
            ext,
        },
    })
}
