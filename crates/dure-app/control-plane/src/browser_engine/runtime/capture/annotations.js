async function ({ base64, annotations, scale, format, quality }) {
  let bitmap, canvas;
  try {
    const encoded = atob(base64);
    const source = Uint8Array.from(encoded, (character) => character.charCodeAt(0));
    bitmap = await createImageBitmap(new Blob([source], { type: "image/png" }));
    if (bitmap.width < 1 || bitmap.height < 1 || bitmap.width > 65535 || bitmap.height > 65535 || bitmap.width * bitmap.height > 16000000) throw Error("capture dimensions");
    canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d");
    context.drawImage(bitmap, 0, 0);
    context.scale(scale, scale);
    context.font = "bold 12px monospace";
    context.textBaseline = "top";
    context.lineWidth = 2;
    for (const { number, box } of annotations) {
      context.strokeStyle = "#e11d48";
      context.strokeRect(box.x + 1, box.y + 1, Math.max(0, box.width - 2), Math.max(0, box.height - 2));
      const label = String(number);
      const width = context.measureText(label).width + 8;
      const x = Math.max(0, Math.min(box.x, bitmap.width / scale - width));
      const y = Math.max(0, Math.min(box.y - 18, bitmap.height / scale - 18));
      context.fillStyle = "#e11d48";
      context.fillRect(x, y, width, 18);
      context.fillStyle = "#ffffff";
      context.fillText(label, x + 4, y + 2);
    }
    const blob = await canvas.convertToBlob({ type: `image/${format}`, quality: quality / 100 });
    if (blob.size > 64 * 1024 * 1024) return blob.size;
    this.bytes = new Uint8Array(await blob.arrayBuffer());
    return this.bytes.length;
  } catch {
    // A rejected awaitPromise can allocate an exception mirror after its CDP
    // object group was released by cancellation. Keep every result primitive.
    return "browser_capture_annotation_failed";
  } finally {
    bitmap?.close();
    if (canvas) { canvas.width = 0; canvas.height = 0; }
  }
}
