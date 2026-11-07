/** Decodes base64 or base64url, with or without padding. */
export function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.replace(/-/gu, '+').replace(/_/gu, '/'));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function decodeBase64Json(value: string): unknown {
  return JSON.parse(new TextDecoder().decode(decodeBase64(value)));
}
