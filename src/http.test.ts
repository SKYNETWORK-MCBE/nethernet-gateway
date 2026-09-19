import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { createRequest, readBody, RequestTooLargeError, requestUrl, writeResponse } from './http';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeServer));
});

describe('HTTP adapters', () => {
  it('converts incoming requests and writes Fetch responses', async () => {
    const address = await serve(async (incoming, response) => {
      const url = requestUrl(incoming);
      const body = await readBody(incoming);
      const request = createRequest(incoming, url, body);
      await writeResponse(
        response,
        Response.json(
          {
            method: request.method,
            url: new URL(request.url).pathname + new URL(request.url).search,
            header: request.headers.get('x-test'),
            body: await request.text(),
          },
          { status: 201, headers: { 'x-response': 'copied' } },
        ),
      );
    });

    const response = await fetch(`${address}/signal?source=test`, {
      method: 'POST',
      headers: { 'x-test': 'kept' },
      body: 'offer',
    });

    expect(response.status).toBe(201);
    expect(response.headers.get('x-response')).toBe('copied');
    expect(await response.json()).toEqual({
      method: 'POST',
      url: '/signal?source=test',
      header: 'kept',
      body: 'offer',
    });
  });

  it('enforces the body limit from both the declared and streamed byte counts', async () => {
    const declared = incomingStream([], { 'content-length': String(1024 * 1024 + 1) });
    await expect(readBody(declared)).rejects.toBeInstanceOf(RequestTooLargeError);

    const streamed = incomingStream([Buffer.alloc(1024 * 1024 + 1)]);
    await expect(readBody(streamed)).rejects.toBeInstanceOf(RequestTooLargeError);
  });
});

function incomingStream(chunks: Buffer[], headers: Record<string, string> = {}): IncomingMessage {
  const request = Readable.from(chunks) as unknown as IncomingMessage;
  request.headers = headers;
  return request;
}

async function serve(
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test server address');
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
