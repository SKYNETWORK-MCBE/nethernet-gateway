import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { RequestTooLargeError } from '../errors';
import type { ConnInfo, ExecutionContext } from '../types';
import { createRequest, writeResponse, writeResponseWhileDraining } from './http';

/** The bindings the Node.js adapter passes as `env`, like `@hono/node-server`. */
export interface NodeBindings {
  incoming: IncomingMessage;
  outgoing: ServerResponse;
}

export type FetchCallback = (
  request: Request,
  env: NodeBindings,
  executionCtx?: ExecutionContext,
) => Promise<Response> | Response;

export interface RequestListenerOptions {
  /** Called when a request cannot be read or a response cannot be written. */
  onError?: (error: unknown) => void;
}

export interface ServeOptions extends RequestListenerOptions {
  fetch: FetchCallback;
  /** Defaults to 3000. */
  port?: number;
  hostname?: string;
}

/** Converts a Fetch handler such as `gateway.fetch` into a `node:http` request listener. */
export function getRequestListener(
  fetch: FetchCallback,
  options: RequestListenerOptions = {},
): (incoming: IncomingMessage, outgoing: ServerResponse) => Promise<void> {
  const { onError } = options;

  return async (incoming, outgoing) => {
    let drainAfterResponse = false;
    let result: Response;
    const { method } = incoming;
    if (method === 'CONNECT' || method === 'TRACE' || method === 'TRACK') {
      // Fetch cannot construct these requests, so answer them before converting.
      incoming.resume();
      result = new Response('Not Found', { status: 404 });
    } else {
      try {
        const request = await createRequest(incoming);
        result = await fetch(request, { incoming, outgoing });
      } catch (error) {
        if (error instanceof RequestTooLargeError) {
          // Keep the connection alive until the 413 is flushed, then discard the remaining body.
          // Closing before that can make unread TCP data turn the response into an ECONNRESET.
          drainAfterResponse = true;
          result = new Response('Request body is too large', { status: 413 });
        } else {
          onError?.(error);
          result = new Response('Internal Server Error', { status: 500 });
        }
      }
    }

    try {
      if (drainAfterResponse) await writeResponseWhileDraining(incoming, outgoing, result);
      else await writeResponse(outgoing, result);
    } catch (error) {
      onError?.(error);
      if (!outgoing.headersSent) {
        try {
          await writeResponse(outgoing, new Response('Internal Server Error', { status: 500 }));
        } catch (fallbackError) {
          onError?.(fallbackError);
          outgoing.destroy();
        }
      } else {
        outgoing.destroy();
      }
    }
  };
}

/** Starts a `node:http` server for a Fetch handler, like `serve` from `@hono/node-server`. */
export function serve(
  options: ServeOptions,
  listeningListener?: (info: { address: string; port: number }) => void,
): Server {
  const server = createServer(getRequestListener(options.fetch, options));
  server.listen(options.port ?? 3000, options.hostname, () => {
    const address = server.address();
    if (address && typeof address !== 'string') {
      listeningListener?.({ address: address.address, port: address.port });
    }
  });
  return server;
}

/** Reads the peer address from the bindings passed by this adapter. */
export function getConnInfo(c: { readonly env: unknown }): ConnInfo {
  const env = c.env as Partial<NodeBindings> | undefined;
  return { remote: { address: env?.incoming?.socket.remoteAddress } };
}
