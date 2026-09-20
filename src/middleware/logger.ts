import type { GatewayMiddleware } from '../types';

export type LoggerPrint = (line: string) => void;

function colorStatus(status: number): string {
  if ('NO_COLOR' in process.env) return String(status);

  const color = status >= 500 ? 31 : status >= 400 ? 33 : status >= 300 ? 36 : 32;
  return `\x1b[${color}m${status}\x1b[0m`;
}

export function logger(print: LoggerPrint = console.log): GatewayMiddleware {
  return async (context, next) => {
    const { method } = context.request;
    const path = context.url.pathname;
    print(`--> ${method} ${path}`);
    const started = performance.now();
    const response = await next();
    print(
      `<-- ${method} ${path} ${colorStatus(response.status)} ${Math.round(performance.now() - started)}ms`,
    );
    return response;
  };
}
