/** Only these image types are embedded or read. SVG can carry script, so it is not one of them. */
export const IMAGE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
export const DATA_IMAGE = /^data:(image\/(?:png|jpeg|gif|webp));base64,([a-z0-9+/=]+)$/i;
export const FIXED_DATE = new Date(2000, 0, 1);

export function toBase64(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

export const fromBase64 = (value: string): Uint8Array => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));

/** Pixel size of a PNG, GIF, or JPEG, read from its header. */
export function imageSize(b: Uint8Array): [number, number] | undefined {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length > 24 && v.getUint32(0) === 0x89504e47) return [v.getUint32(16), v.getUint32(20)];
  if (b.length > 10 && v.getUint32(0) === 0x47494638) return [v.getUint16(6, true), v.getUint16(8, true)];
  if (b.length > 4 && v.getUint16(0) === 0xffd8) {
    for (let i = 2; i + 9 < b.length && b[i] === 0xff; i += 2 + v.getUint16(i + 2)) {
      if (b[i + 1] >= 0xc0 && b[i + 1] <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(b[i + 1])) return [v.getUint16(i + 7), v.getUint16(i + 5)];
    }
  }
  return undefined;
}
