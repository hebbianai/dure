use super::{action, read};
use std::path::Path;

pub(super) async fn exercise(
    root: &Path,
    resource: &str,
    page: &str,
    epoch: &str,
) -> Result<(), String> {
    read(root, resource, page, epoch, "const input=document.querySelector('input');input.value='protected';input.focus();input.setSelectionRange(9,9);window.blockedShortcut=null;window.blockSelectAll=e=>{if(e.code==='KeyA'&&(e.metaKey||e.ctrlKey)){e.preventDefault();blockedShortcut={trusted:e.isTrusted,prevented:e.defaultPrevented};}};document.addEventListener('keydown',blockSelectAll);true").await?;
    let select_all = if cfg!(target_os = "macos") {
        "Meta+a"
    } else {
        "Control+a"
    };
    action(root, resource, page, epoch, "key", &[select_all]).await?;
    action(root, resource, page, epoch, "key", &["z"]).await?;
    let prevented = read(
        root,
        resource,
        page,
        epoch,
        "({text:document.querySelector('input').value,blocked:blockedShortcut})",
    )
    .await?;
    if prevented["text"] != "protectedz"
        || prevented["blocked"]["trusted"] != true
        || prevented["blocked"]["prevented"] != true
    {
        return Err(format!(
            "editing bypassed the page's key handler: {prevented}"
        ));
    }
    read(root, resource, page, epoch, "document.removeEventListener('keydown',blockSelectAll);const editor=document.createElement('div');editor.id='keyboard-editor';editor.contentEditable='true';editor.textContent='alpha beta';document.body.append(editor);editor.focus();const range=document.createRange();range.selectNodeContents(editor);range.collapse(false);getSelection().removeAllRanges();getSelection().addRange(range);true").await?;
    let select_word = if cfg!(target_os = "macos") {
        "Alt+Shift+ArrowLeft"
    } else {
        "Control+Shift+ArrowLeft"
    };
    action(root, resource, page, epoch, "key", &[select_word]).await?;
    let selection = read(root, resource, page, epoch, "getSelection().toString()").await?;
    if selection != "beta" {
        return Err(format!("word selection did not select beta: {selection}"));
    }
    action(root, resource, page, epoch, "key", &["Z"]).await?;
    let undo = if cfg!(target_os = "macos") {
        "Meta+z"
    } else {
        "Control+z"
    };
    let redo = if cfg!(target_os = "macos") {
        "Meta+Shift+z"
    } else {
        "Control+Shift+z"
    };
    for (command, expected) in [
        (None, "alpha Z"),
        (Some(undo), "alpha beta"),
        (Some(redo), "alpha Z"),
    ] {
        if let Some(command) = command {
            action(root, resource, page, epoch, "key", &[command]).await?;
        }
        let text = read(
            root,
            resource,
            page,
            epoch,
            "document.querySelector('#keyboard-editor').textContent",
        )
        .await?;
        if text != expected {
            return Err(format!(
                "contenteditable {command:?}: expected {expected:?}, got {text}"
            ));
        }
    }
    println!(
        "BROWSER_KEYBOARD_EDITING_CLI prevented={prevented} selection={selection} undo_redo=passed"
    );
    read(root, resource, page, epoch, "document.querySelector('#keyboard-editor').remove();document.querySelector('input').focus();true").await?;
    Ok(())
}
