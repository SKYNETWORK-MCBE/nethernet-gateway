import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

const MAX_OFFER_BYTES = 1024 * 1024;

export class RequestTooLargeError extends Error {}

function requestUrl(request: IncomingMessage): URL {
  return new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
}

export function createRequest(incoming: IncomingMessage): Request {
  const headers = new Headers();
  for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
    headers.append(incoming.rawHeaders[index], incoming.rawHeaders[index + 1]);
  }

  const init: RequestInit & { duplex?: 'half' } = {
    method: incoming.method,
    headers,
  };
  if (incoming.method !== 'GET' && incoming.method !== 'HEAD') {
    init.body = Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
    init.duplex = 'half';
  }

  return new Request(requestUrl(incoming), init);
}

export async function readBody(request: Request): Promise<string> {
  const declaredLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_OFFER_BYTES) {
    throw new RequestTooLargeError();
  }

  // Enforce README's 1 MiB limit while streaming, including requests without a declared length:
  // [Security](../README.md#security)
  const chunks: Buffer[] = [];
  let length = 0;
  const reader = request.body?.getReader();
  if (!reader) return '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const buffer = Buffer.from(value);
      length += buffer.length;
      if (length > MAX_OFFER_BYTES) throw new RequestTooLargeError();
      chunks.push(buffer);
    }
  } catch (error) {
    void reader.cancel();
    throw error;
  }

  return Buffer.concat(chunks).toString('utf8');
}

export async function writeResponse(response: ServerResponse, result: Response): Promise<void> {
  const body = Buffer.from(await result.arrayBuffer());
  response.statusCode = result.status;
  response.statusMessage = result.statusText;
  result.headers.forEach((value, name) => response.setHeader(name, value));
  // Middleware may have replaced the body, so the upstream length no longer describes it. RFC 9110
  // §8.6 keeps a 204 from carrying the field at all, and leaves a 304 describing the representation
  // it stands in for rather than the empty body it sends.
  // If the status is 304, the runtime will throw a TypeError, so we don't need to remove the header ourselves.
  if (result.status === 204) response.removeHeader('content-length');
  else if (result.status !== 304) response.setHeader('content-length', body.length);
  response.end(body);
}
