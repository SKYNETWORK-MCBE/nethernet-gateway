import type { GatewayMiddleware } from '../types';

export type LoggerPrint = (line: string) => void;

function colorStatus(status: number): string {
  if ('NO_COLOR' in process.env) return String(status);

  const color = status >= 500 ? 31 : status >= 400 ? 33 : status >= 300 ? 36 : 32;
  return `\x1b[${color}m${status}\x1b[0m`;
}

export function logger(print: LoggerPrint = console.log): GatewayMiddleware {
  return async (c, next) => {
    const { method } = c.req;
    const path = c.url.pathname;
    print(`--> ${method} ${path}`);
    const started = performance.now();
    let status = 500;
    try {
      const response = await next();
      status = response.status;
      return response;
    } finally {
      print(
        `<-- ${method} ${path} ${colorStatus(status)} ${Math.round(performance.now() - started)}ms`,
      );
    }
  };
}
