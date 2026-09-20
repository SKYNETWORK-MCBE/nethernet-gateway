import type { IncomingMessage, ServerResponse } from 'node:http';

const MAX_OFFER_BYTES = 1024 * 1024;

export class RequestTooLargeError extends Error {}
export class InvalidRequestBodyError extends Error {}

function requestUrl(request: IncomingMessage): URL {
  return new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
}

export async function createRequest(incoming: IncomingMessage): Promise<Request> {
  const headers = new Headers();
  for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
    headers.append(incoming.rawHeaders[index], incoming.rawHeaders[index + 1]);
  }

  // Buffer at the Node boundary so middleware can clone the request and the socket can be reused.
  const body = await readIncomingBody(incoming);
  headers.delete('transfer-encoding');

  const init: RequestInit = {
    method: incoming.method,
    headers,
  };
  if (incoming.method !== 'GET' && incoming.method !== 'HEAD') {
    headers.set('content-length', String(body.byteLength));
    init.body = new Uint8Array(body);
  } else {
    headers.delete('content-length');
  }

  return new Request(requestUrl(incoming), init);
}

export async function readBody(request: Request): Promise<string> {
  const declaredLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_OFFER_BYTES) {
    throw new RequestTooLargeError();
  }

  const body = Buffer.from(await request.arrayBuffer());
  if (body.byteLength > MAX_OFFER_BYTES) throw new RequestTooLargeError();
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    throw new InvalidRequestBodyError();
  }
}

async function readIncomingBody(incoming: IncomingMessage): Promise<Buffer> {
  const declaredLength = Number(incoming.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_OFFER_BYTES) {
    incoming.resume();
    throw new RequestTooLargeError();
  }

  const chunks: Buffer[] = [];
  let length = 0;
  let tooLarge = false;
  for await (const chunk of incoming) {
    const buffer = Buffer.from(chunk);
    length += buffer.byteLength;
    if (length > MAX_OFFER_BYTES) {
      tooLarge = true;
      chunks.length = 0;
    } else if (!tooLarge) {
      chunks.push(buffer);
    }
  }

  if (tooLarge) throw new RequestTooLargeError();
  return Buffer.concat(chunks, length);
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
