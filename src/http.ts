import type { IncomingMessage, ServerResponse } from 'node:http';

const MAX_OFFER_BYTES = 1024 * 1024;

export class RequestTooLargeError extends Error {}

export function requestUrl(request: IncomingMessage): URL {
  return new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
}

export function createRequest(incoming: IncomingMessage, url: URL, body?: string): Request {
  const headers = new Headers();
  for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
    headers.append(incoming.rawHeaders[index], incoming.rawHeaders[index + 1]);
  }

  return new Request(url, {
    method: incoming.method,
    headers,
    body,
  });
}

export async function readBody(request: IncomingMessage): Promise<string> {
  const declaredLength = Number(request.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_OFFER_BYTES) {
    throw new RequestTooLargeError();
  }

  // Enforce README's 1 MiB limit while streaming, including requests without a declared length:
  // [Security](../README.md#security)
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > MAX_OFFER_BYTES) throw new RequestTooLargeError();
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function writeResponse(response: ServerResponse, result: Response): Promise<void> {
  const body = Buffer.from(await result.arrayBuffer());
  response.statusCode = result.status;
  response.statusMessage = result.statusText;
  result.headers.forEach((value, name) => response.setHeader(name, value));
  // Middleware may have replaced the body, so the upstream length no longer describes it.
  response.setHeader('content-length', body.length);
  response.end(body);
}
