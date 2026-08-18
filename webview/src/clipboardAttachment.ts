export const MAX_CLIPBOARD_IMAGE_BYTES = 10 * 1024 * 1024;

export interface EncodedClipboardImage {
  readonly name: string;
  readonly mimeType: string;
  readonly data: string;
}

export async function encodeClipboardImage(
  file: Pick<File, "arrayBuffer" | "name" | "size" | "type">,
): Promise<EncodedClipboardImage> {
  if (!file.type.startsWith("image/")) {
    throw new Error("Only images can be pasted from the clipboard.");
  }
  if (file.size <= 0 || file.size > MAX_CLIPBOARD_IMAGE_BYTES) {
    throw new Error("Clipboard images must be between 1 byte and 10 MB.");
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunkSize = 32_768;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + chunkSize),
    );
  }
  return {
    name: file.name || "clipboard-image",
    mimeType: file.type,
    data: btoa(binary),
  };
}
