import { afterEach, describe, expect, it } from 'vite-plus/test';
import { RequestTooLargeError } from './errors';
import { createRequest, readBody, writeResponse } from './http';
import { createTestServers } from './test-helpers';

const { serve, closeAll } = createTestServers();

afterEach(closeAll);

describe('HTTP adapters', () => {
  it('converts incoming requests and writes Fetch responses', async () => {
    const address = await serve(async (incoming, response) => {
      const request = await createRequest(incoming);
      await writeResponse(
        response,
        Response.json(
          {
            method: request.method,
            url: new URL(request.url).pathname + new URL(request.url).search,
            header: request.headers.get('x-test'),
            body: await readBody(request),
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

  // RFC 9110 section 8.6: a 204 carries no length, and a 304 keeps the one it was given.
  it.each([
    [200, 'rewritten', '9'],
    [204, '', null],
    [304, '', '5000'],
  ])('writes the content length of a %s response', async (status, body, expected) => {
    const address = await serve(async (_incoming, response) => {
      await writeResponse(
        response,
        new Response(body || null, { status, headers: { 'content-length': '5000' } }),
      );
    });

    const response = await fetch(address);

    expect(response.status).toBe(status);
    expect(response.headers.get('content-length')).toBe(expected);
  });

  it('enforces the body limit from both the declared and streamed byte counts', async () => {
    const declared = new Request('http://localhost', {
      method: 'POST',
      headers: { 'content-length': String(1024 * 1024 + 1) },
    });
    await expect(readBody(declared)).rejects.toBeInstanceOf(RequestTooLargeError);

    let cancelled = false;
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
        return new Promise(() => {});
      },
      pull(controller) {
        if (pulls === 64) return controller.close();
        pulls++;
        controller.enqueue(new Uint8Array(64 * 1024));
      },
    });
    const streamed = new Request('http://localhost', {
      method: 'POST',
      body,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    await expect(readBody(streamed)).rejects.toBeInstanceOf(RequestTooLargeError);
    expect(cancelled).toBe(false);
    expect(pulls).toBeLessThan(64);

    const transferEncoded = new Request('http://localhost', {
      method: 'POST',
      headers: {
        'content-length': String(1024 * 1024 + 1),
        'transfer-encoding': 'chunked',
      },
      body: 'offer',
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    await expect(readBody(transferEncoded)).resolves.toBe('offer');
  });
});
