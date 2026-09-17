/// Read current native clipboard pixels; copied image files take precedence over icons.
pub(super) fn read_png() -> Option<Vec<u8>> {
    use objc2_app_kit::NSPasteboard;
    image_from_pasteboard(&NSPasteboard::generalPasteboard())
}

// The command returns one image: select the first readable copied image file.
fn image_from_pasteboard(pasteboard: &objc2_app_kit::NSPasteboard) -> Option<Vec<u8>> {
    use objc2_app_kit::{NSPasteboardTypeFileURL, NSPasteboardTypePNG, NSPasteboardTypeTIFF};

    let mut has_files = false;
    if let Some(items) = pasteboard.pasteboardItems() {
        for index in 0..items.count() {
            let item = items.objectAtIndex(index);
            if let Some(file_url) = item.stringForType(unsafe { NSPasteboardTypeFileURL }) {
                has_files = true;
                if let Some(png) = image_from_file_url(&file_url) {
                    return Some(png);
                }
            }
        }
    }
    // File icons are not a fallback for unreadable or non-image copied files.
    if has_files {
        return None;
    }
    if let Some(png) = unsafe { pasteboard.dataForType(NSPasteboardTypePNG) } {
        return Some(png.to_vec());
    }
    let tiff = unsafe { pasteboard.dataForType(NSPasteboardTypeTIFF) }?;
    encode_png(&tiff)
}

fn image_from_file_url(file_url: &objc2_foundation::NSString) -> Option<Vec<u8>> {
    use objc2_foundation::{NSData, NSURL};
    use std::io::Read;

    let url = NSURL::URLWithString(file_url)?;
    if !url.isFileURL()
        || url.host().is_some_and(|host| {
            !host.is_empty() && !host.to_string().eq_ignore_ascii_case("localhost")
        })
    {
        return None;
    }
    let path = url.to_file_path()?;
    let metadata = std::fs::metadata(&path).ok()?;
    let limit = crate::files::MAX_FILE_BYTES;
    if !metadata.is_file() || metadata.len() > limit {
        return None;
    }
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .ok()?
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() as u64 > limit {
        return None;
    }
    encode_png(&NSData::with_bytes(&bytes))
}

fn encode_png(data: &objc2_foundation::NSData) -> Option<Vec<u8>> {
    use objc2::AnyThread;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep};
    use objc2_foundation::NSDictionary;

    let rep = NSBitmapImageRep::initWithData(NSBitmapImageRep::alloc(), data)?;
    let bytes = data.to_vec();
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some(bytes);
    }
    let png = unsafe {
        rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new())
    }?;
    Some(png.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;
    use objc2_app_kit::{NSPasteboard, NSPasteboardTypeFileURL, NSPasteboardTypePNG};
    use objc2_foundation::{NSData, NSString, NSURL};

    #[test]
    fn finder_file_pixels_win_over_the_file_icon() {
        let pasteboard = NSPasteboard::pasteboardWithUniqueName();
        let icon = NSData::with_bytes(include_bytes!("../icons/Square30x30Logo.png"));
        let directory = tempfile::tempdir().unwrap();
        let image_path = directory.path().join("image with spaces.png");
        std::fs::write(
            &image_path,
            include_bytes!("../icons/Square142x142Logo.png"),
        )
        .unwrap();
        let url = NSURL::fileURLWithPath(&NSString::from_str(image_path.to_str().unwrap()));
        assert!(
            pasteboard.setString_forType(&url.absoluteString().unwrap(), unsafe {
                NSPasteboardTypeFileURL
            })
        );
        assert!(pasteboard.setData_forType(Some(&icon), unsafe { NSPasteboardTypePNG }));
        let actual = image_from_pasteboard(&pasteboard).unwrap();
        assert!(
            actual == std::fs::read(image_path).unwrap(),
            "file pixels must win over its icon"
        );
        pasteboard.clearContents();
    }

    #[test]
    fn ordinary_image_clipboard_keeps_original_png_bytes() {
        let pasteboard = NSPasteboard::pasteboardWithUniqueName();
        let image = include_bytes!("../icons/Square142x142Logo.png");
        assert!(
            pasteboard.setData_forType(Some(&NSData::with_bytes(image)), unsafe {
                NSPasteboardTypePNG
            })
        );
        assert_eq!(image_from_pasteboard(&pasteboard).unwrap(), image);
        pasteboard.clearContents();
    }

    #[test]
    fn file_url_cannot_trigger_a_network_image_read() {
        let pasteboard = NSPasteboard::pasteboardWithUniqueName();
        assert!(pasteboard.setString_forType(
            &NSString::from_str("https://example.invalid/image.png"),
            unsafe { NSPasteboardTypeFileURL },
        ));
        assert!(image_from_pasteboard(&pasteboard).is_none());
        pasteboard.clearContents();
    }

    #[test]
    fn non_image_file_is_not_replaced_with_its_icon() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("text.txt");
        std::fs::write(&path, b"not an image").unwrap();
        let pasteboard = NSPasteboard::pasteboardWithUniqueName();
        let url = NSURL::fileURLWithPath(&NSString::from_str(path.to_str().unwrap()));
        assert!(
            pasteboard.setString_forType(&url.absoluteString().unwrap(), unsafe {
                NSPasteboardTypeFileURL
            })
        );
        assert!(pasteboard.setData_forType(
            Some(&NSData::with_bytes(include_bytes!(
                "../icons/Square30x30Logo.png"
            ))),
            unsafe { NSPasteboardTypePNG }
        ));
        assert!(image_from_pasteboard(&pasteboard).is_none());
        pasteboard.clearContents();
    }

    #[test]
    fn tiff_clipboard_and_copied_tiff_file_keep_their_pixels() {
        use objc2::AnyThread;
        use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSPasteboardTypeTIFF};
        use objc2_foundation::NSDictionary;

        let source = NSBitmapImageRep::initWithData(
            NSBitmapImageRep::alloc(),
            &NSData::with_bytes(include_bytes!("../icons/Square142x142Logo.png")),
        )
        .unwrap();
        let tiff = unsafe {
            source.representationUsingType_properties(
                NSBitmapImageFileType::TIFF,
                &NSDictionary::new(),
            )
        }
        .unwrap();
        let pasteboard = NSPasteboard::pasteboardWithUniqueName();
        assert!(pasteboard.setData_forType(Some(&tiff), unsafe { NSPasteboardTypeTIFF }));
        let clipboard_png = image_from_pasteboard(&pasteboard).unwrap();
        assert!(clipboard_png.starts_with(b"\x89PNG\r\n\x1a\n"));
        let decoded = NSBitmapImageRep::initWithData(
            NSBitmapImageRep::alloc(),
            &NSData::with_bytes(&clipboard_png),
        )
        .unwrap();
        assert_eq!((decoded.pixelsWide(), decoded.pixelsHigh()), (142, 142));

        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("image.tiff");
        std::fs::write(&path, tiff.to_vec()).unwrap();
        let url = NSURL::fileURLWithPath(&NSString::from_str(path.to_str().unwrap()));
        assert!(
            pasteboard.setString_forType(&url.absoluteString().unwrap(), unsafe {
                NSPasteboardTypeFileURL
            })
        );
        assert!(pasteboard.setData_forType(
            Some(&NSData::with_bytes(include_bytes!(
                "../icons/Square30x30Logo.png"
            ))),
            unsafe { NSPasteboardTypePNG }
        ));
        assert!(image_from_pasteboard(&pasteboard).unwrap() == clipboard_png);
        pasteboard.clearContents();
    }

    #[test]
    fn multiple_copied_files_choose_first_readable_image() {
        use objc2::runtime::ProtocolObject;
        use objc2_app_kit::{NSPasteboardItem, NSPasteboardWriting};
        use objc2_foundation::NSArray;

        let directory = tempfile::tempdir().unwrap();
        let paths = ["text.txt", "first.png", "second.png"];
        let contents: [&[u8]; 3] = [
            b"text",
            include_bytes!("../icons/Square142x142Logo.png"),
            include_bytes!("../icons/Square30x30Logo.png"),
        ];
        let items: Vec<_> = paths
            .iter()
            .zip(contents)
            .map(|(name, bytes)| {
                let path = directory.path().join(name);
                std::fs::write(&path, bytes).unwrap();
                let url = NSURL::fileURLWithPath(&NSString::from_str(path.to_str().unwrap()));
                let item = NSPasteboardItem::new();
                assert!(
                    item.setString_forType(&url.absoluteString().unwrap(), unsafe {
                        NSPasteboardTypeFileURL
                    })
                );
                item
            })
            .collect();
        let objects: Vec<&ProtocolObject<dyn NSPasteboardWriting>> = items
            .iter()
            .map(|item| ProtocolObject::from_ref(&**item))
            .collect();
        let pasteboard = NSPasteboard::pasteboardWithUniqueName();
        assert!(pasteboard.writeObjects(&NSArray::from_slice(&objects)));
        assert!(image_from_pasteboard(&pasteboard).as_deref() == Some(contents[1]));
        pasteboard.clearContents();
    }

    #[test]
    fn remote_file_authority_is_rejected_before_reading() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("image.png");
        std::fs::write(&path, include_bytes!("../icons/Square142x142Logo.png")).unwrap();
        let url = NSURL::fileURLWithPath(&NSString::from_str(path.to_str().unwrap()));
        let remote = url.absoluteString().unwrap().to_string().replacen(
            "file://",
            "file://remote.invalid",
            1,
        );
        let pasteboard = NSPasteboard::pasteboardWithUniqueName();
        assert!(
            pasteboard.setString_forType(&NSString::from_str(&remote), unsafe {
                NSPasteboardTypeFileURL
            })
        );
        assert!(image_from_pasteboard(&pasteboard).is_none());
        pasteboard.clearContents();
    }

    #[test]
    fn oversized_copied_image_is_rejected_without_truncating() {
        use std::io::Write;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("large.png");
        let mut file = std::fs::File::create(&path).unwrap();
        file.write_all(include_bytes!("../icons/Square142x142Logo.png"))
            .unwrap();
        file.set_len(crate::files::MAX_FILE_BYTES + 1).unwrap();
        let url = NSURL::fileURLWithPath(&NSString::from_str(path.to_str().unwrap()));
        let pasteboard = NSPasteboard::pasteboardWithUniqueName();
        assert!(
            pasteboard.setString_forType(&url.absoluteString().unwrap(), unsafe {
                NSPasteboardTypeFileURL
            })
        );
        assert_eq!(
            std::fs::metadata(&path).unwrap().len(),
            crate::files::MAX_FILE_BYTES + 1
        );
        assert!(
            image_from_file_url(&url.absoluteString().unwrap()).is_none(),
            "file reader must reject oversized bytes"
        );
        assert!(image_from_pasteboard(&pasteboard).is_none());
        pasteboard.clearContents();
    }
}
