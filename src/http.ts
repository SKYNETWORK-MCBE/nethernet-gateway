import { InvalidRequestBodyError, RequestTooLargeError } from './errors';

export const MAX_OFFER_BYTES = 1024 * 1024;

export async function readBody(request: Request): Promise<string> {
  const declaredLength = Number(request.headers.get('content-length'));
  if (
    !request.headers.has('transfer-encoding') &&
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_OFFER_BYTES
  ) {
    throw new RequestTooLargeError();
  }
  if (!request.body) return '';

  const chunks: Uint8Array[] = [];
  let length = 0;
  // A middleware owns its stream and may reuse it after next(), so release it rather than cancel.
  const reader = request.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_OFFER_BYTES) throw new RequestTooLargeError();
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new InvalidRequestBodyError();
  }
}
