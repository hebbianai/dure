use super::*;

fn manifest(name: &str, bytes: &[u8]) -> Value {
    json!({"name":name,"size":bytes.len(),"sha256":format!("{:x}",Sha256::digest(bytes))})
}

fn chunk(file: &Value, offset: u64, bytes: &[u8]) -> BrowserUploadChunk {
    serde_json::from_value(json!({"file":file,"offset":offset,"base64":STANDARD.encode(bytes)}))
        .unwrap()
}

#[tokio::test]
async fn bounded_reads_preserve_the_original_reader_and_reject_changed_bytes() {
    let root = tempfile::tempdir().unwrap();
    let other = tempfile::tempdir().unwrap();
    let mut uploads = BrowserUploads::new(root.path());
    let mut peer = BrowserUploads::new(other.path());
    let bytes = "한글".as_bytes();
    let complete = uploads
        .stage(chunk(&manifest("baseline.txt", bytes), 0, bytes))
        .await
        .unwrap();
    let id: BrowserUploadId = serde_json::from_value(complete["id"].clone()).unwrap();
    assert_eq!(
        uploads.read_sealed_with_limit(&id, 5).await.unwrap_err(),
        "browser_upload_byte_limit"
    );
    assert_eq!(uploads.read_sealed(&id).await.unwrap(), bytes);
    assert_eq!(uploads.read_sealed_with_limit(&id, 6).await.unwrap(), bytes);
    assert_eq!(
        peer.read_sealed_with_limit(&id, 6).await.unwrap_err(),
        "browser_upload_incomplete"
    );
    let path = uploads
        .sealed(std::slice::from_ref(&id))
        .unwrap()
        .0
        .remove(0);
    std::fs::write(path, b"edited").unwrap();
    assert_eq!(
        uploads.read_sealed_with_limit(&id, 6).await.unwrap_err(),
        "browser_upload_file_changed"
    );
    assert_eq!(
        uploads.read_sealed(&id).await.unwrap_err(),
        "browser_upload_file_changed"
    );
}

#[tokio::test]
async fn interrupted_chunks_resume_without_replacing_already_received_bytes() {
    let root = tempfile::tempdir().unwrap();
    let mut uploads = BrowserUploads::new(root.path());
    let bytes = vec![0x63; CHUNK_BYTES + 123];
    let manifest = manifest("첨부 파일.txt", &bytes);
    let first = uploads
        .stage(chunk(&manifest, 0, &bytes[..CHUNK_BYTES]))
        .await
        .unwrap();
    let id: BrowserUploadId = serde_json::from_value(first["id"].clone()).unwrap();
    assert_eq!(first["complete"], false);
    assert_eq!(
        uploads.sealed(std::slice::from_ref(&id)).unwrap_err(),
        "browser_upload_incomplete"
    );
    assert_eq!(
        uploads
            .stage(chunk(&manifest, 0, &bytes[..CHUNK_BYTES]))
            .await
            .unwrap(),
        first
    );
    assert_eq!(
        uploads
            .stage(chunk(&manifest, 0, &[0x64]))
            .await
            .unwrap_err(),
        "browser_upload_chunk_conflict"
    );
    assert_eq!(
        uploads
            .stage(chunk(&manifest, CHUNK_BYTES as u64 + 1, &[0x63]))
            .await
            .unwrap_err(),
        "browser_upload_offset_invalid"
    );
    let complete = uploads
        .stage(chunk(&manifest, CHUNK_BYTES as u64, &bytes[CHUNK_BYTES..]))
        .await
        .unwrap();
    assert_eq!(complete["complete"], true);
    let (paths, _) = uploads.sealed(std::slice::from_ref(&id)).unwrap();
    assert_eq!(std::fs::read(&paths[0]).unwrap(), bytes);
    assert_eq!(
        uploads
            .stage(chunk(&manifest, 0, &bytes[..CHUNK_BYTES]))
            .await
            .unwrap(),
        complete
    );
    uploads.clear();
    assert!(!paths[0].exists());
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
}

#[tokio::test]
async fn corrupt_content_never_becomes_attachable_and_can_be_retransferred() {
    let root = tempfile::tempdir().unwrap();
    let mut uploads = BrowserUploads::new(root.path());
    let manifest = manifest("data.bin", b"right");
    assert_eq!(
        uploads
            .stage(chunk(&manifest, 0, b"wrong"))
            .await
            .unwrap_err(),
        "browser_upload_digest_mismatch"
    );
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
    let complete = uploads.stage(chunk(&manifest, 0, b"right")).await.unwrap();
    let id = serde_json::from_value(complete["id"].clone()).unwrap();
    assert_eq!(
        std::fs::read(&uploads.sealed(&[id]).unwrap().0[0]).unwrap(),
        b"right"
    );
}

#[tokio::test]
async fn empty_files_are_valid_but_a_resource_cannot_adopt_another_resources_files() {
    let root = tempfile::tempdir().unwrap();
    let other = tempfile::tempdir().unwrap();
    let mut uploads = BrowserUploads::new(root.path());
    let other_uploads = BrowserUploads::new(other.path());
    let complete = uploads
        .stage(chunk(&manifest("empty.txt", b""), 0, b""))
        .await
        .unwrap();
    let id: BrowserUploadId = serde_json::from_value(complete["id"].clone()).unwrap();
    assert_eq!(complete["complete"], true);
    assert_eq!(
        other_uploads.sealed(std::slice::from_ref(&id)).unwrap_err(),
        "browser_upload_incomplete"
    );
    let path = uploads.sealed(&[id]).unwrap().0.remove(0);
    assert!(std::fs::read(path).unwrap().is_empty());
    for name in ["../outside", "/tmp/outside", "a/b", "a\\b", ".", "..", ""] {
        assert!(
            serde_json::from_value::<BrowserUploadChunk>(
                json!({"file":manifest(name,b""),"offset":0,"base64":""})
            )
            .is_err()
        );
    }
    assert!(serde_json::from_value::<BrowserUploadId>(json!("/etc/passwd")).is_err());
    assert_eq!(std::fs::read_dir(other.path()).unwrap().count(), 0);
}

#[tokio::test]
async fn incomplete_files_reserve_their_full_size_until_resource_retirement() {
    let root = tempfile::tempdir().unwrap();
    let mut uploads = BrowserUploads::new(root.path());
    for index in 0..4 {
        let file =
            json!({"name":format!("part{index}.bin"),"size":MAX_BYTES,"sha256":"0".repeat(64)});
        assert_eq!(
            uploads.stage(chunk(&file, 0, b"x")).await.unwrap()["complete"],
            false
        );
    }
    assert_eq!(
        uploads
            .stage(chunk(&manifest("extra", b"x"), 0, b"x"))
            .await
            .unwrap_err(),
        "browser_upload_resource_limit"
    );
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 4);
    uploads.clear();
    assert_eq!(
        uploads
            .stage(chunk(&manifest("extra", b"x"), 0, b"x"))
            .await
            .unwrap()["complete"],
        true
    );
}
