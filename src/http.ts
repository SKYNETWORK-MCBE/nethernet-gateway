import type { IncomingMessage, ServerResponse } from 'node:http';
import { finished } from 'node:stream/promises';
import { InvalidRequestBodyError, RequestTooLargeError } from './errors';

const MAX_OFFER_BYTES = 1024 * 1024;
const DRAIN_TIMEOUT_MS = 500;
const MAX_DRAIN_BYTES = 64 * 1024 * 1024;

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
  if (
    !request.headers.has('transfer-encoding') &&
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_OFFER_BYTES
  ) {
    throw new RequestTooLargeError();
  }

  const chunks: Buffer[] = [];
  let length = 0;
  if (!request.body) return '';

  // A middleware owns its stream and may reuse it after next(), so never wait for its cancel().
  for await (const value of request.body.values({ preventCancel: true })) {
    const chunk = Buffer.from(value);
    length += chunk.byteLength;
    if (length > MAX_OFFER_BYTES) throw new RequestTooLargeError();
    chunks.push(chunk);
  }

  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      Buffer.concat(chunks, length),
    );
  } catch {
    throw new InvalidRequestBodyError();
  }
}

async function readIncomingBody(incoming: IncomingMessage): Promise<Buffer> {
  const declaredLength = Number(incoming.headers['content-length']);
  if (
    incoming.headers['transfer-encoding'] === undefined &&
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_OFFER_BYTES
  ) {
    throw new RequestTooLargeError();
  }

  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of incoming.iterator({ destroyOnReturn: false })) {
    const buffer = Buffer.from(chunk);
    length += buffer.byteLength;
    if (length > MAX_OFFER_BYTES) throw new RequestTooLargeError();
    chunks.push(buffer);
  }

  return Buffer.concat(chunks, length);
}

export async function writeResponse(response: ServerResponse, result: Response): Promise<void> {
  const body = await prepareResponse(response, result);
  const flushed = finished(response, { cleanup: true });
  response.end(body);
  await flushed;
}

export async function writeResponseWhileDraining(
  incoming: IncomingMessage,
  response: ServerResponse,
  result: Response,
): Promise<void> {
  const body = await prepareResponse(response, result);

  // Based on @hono/node-server's bounded early-response cleanup:
  // https://github.com/honojs/node-server/commit/70250f780ec99d2ddc0dd8275a42f8e091e06e94
  // Send the complete 413 before draining, but keep the ServerResponse active so
  // server.close() cannot discard it.
  response.flushHeaders();
  await new Promise<void>((resolve, reject) => {
    response.write(body, (error) => (error ? reject(error) : resolve()));
  });

  const forceClose = await drainIncomingBody(incoming);
  const flushed = finished(response, { cleanup: true });
  response.end();
  await flushed;
  if (forceClose && !incoming.socket.destroyed) incoming.socket.destroySoon();
}

async function prepareResponse(response: ServerResponse, result: Response): Promise<Buffer> {
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
  return body;
}

async function drainIncomingBody(incoming: IncomingMessage): Promise<boolean> {
  if (incoming.destroyed || incoming.readableEnded) return false;

  return new Promise<boolean>((resolve) => {
    let drained = 0;
    const timeout = setTimeout(() => finish(true), DRAIN_TIMEOUT_MS);
    timeout.unref();

    const onData = (chunk: Buffer) => {
      drained += chunk.byteLength;
      if (drained > MAX_DRAIN_BYTES) finish(true);
    };

    function cleanup() {
      clearTimeout(timeout);
      incoming.off('data', onData);
      incoming.off('end', onEnd);
      incoming.off('error', onAbort);
      incoming.off('aborted', onAbort);
    }

    function finish(forceClose: boolean) {
      cleanup();
      incoming.pause();
      resolve(forceClose);
    }

    function onEnd() {
      finish(false);
    }

    function onAbort() {
      finish(false);
    }

    incoming.on('data', onData);
    incoming.once('end', onEnd);
    incoming.once('error', onAbort);
    incoming.once('aborted', onAbort);
    incoming.resume();
  });
}
