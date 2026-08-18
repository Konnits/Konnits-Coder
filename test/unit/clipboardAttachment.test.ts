import { describe, expect, it } from "vitest";
import {
  encodeClipboardImage,
  MAX_CLIPBOARD_IMAGE_BYTES,
} from "../../webview/src/clipboardAttachment.js";

describe("clipboard image attachments", () => {
  it("encodes an image without changing its metadata", async () => {
    const encoded = await encodeClipboardImage({
      name: "screenshot.png",
      type: "image/png",
      size: 4,
      arrayBuffer: async () => Uint8Array.from([0, 1, 2, 255]).buffer,
    });

    expect(encoded).toEqual({
      name: "screenshot.png",
      mimeType: "image/png",
      data: "AAEC/w==",
    });
  });

  it("rejects non-images and oversized clipboard data", async () => {
    await expect(
      encodeClipboardImage({
        name: "notes.txt",
        type: "text/plain",
        size: 4,
        arrayBuffer: async () => new ArrayBuffer(4),
      }),
    ).rejects.toThrow("Only images");
    await expect(
      encodeClipboardImage({
        name: "large.png",
        type: "image/png",
        size: MAX_CLIPBOARD_IMAGE_BYTES + 1,
        arrayBuffer: async () => new ArrayBuffer(0),
      }),
    ).rejects.toThrow("10 MB");
  });
});
