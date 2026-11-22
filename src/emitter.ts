// A minimal, runtime-agnostic subset of node:events' EventEmitter.

type Listener<Args extends unknown[]> = (...args: Args) => void;
// `original` is set on a once() wrapper so off() can find it by the listener that was passed.
type AnyListener = Listener<never[]> & { original?: unknown };

export class Emitter<Events extends { [K in keyof Events]: unknown[] }> {
  private readonly listeners = new Map<keyof Events, AnyListener[]>();

  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): this {
    const list = this.listeners.get(event) ?? [];
    list.push(listener as unknown as AnyListener);
    this.listeners.set(event, list);
    return this;
  }

  once<K extends keyof Events>(event: K, listener: Listener<Events[K]>): this {
    const wrapper: Listener<Events[K]> & { original?: unknown } = (...args) => {
      this.off(event, wrapper);
      listener(...args);
    };
    wrapper.original = listener;
    return this.on(event, wrapper);
  }

  off<K extends keyof Events>(event: K, listener: Listener<Events[K]>): this {
    const list = this.listeners.get(event);
    const target: unknown = listener;
    const index =
      list?.findLastIndex((entry) => entry === target || entry.original === target) ?? -1;
    if (index !== -1) list!.splice(index, 1);
    return this;
  }

  /** Like node:events, a throwing listener stops the remaining listeners and rethrows. */
  emit<K extends keyof Events>(event: K, ...args: Events[K]): boolean {
    const list = this.listeners.get(event);
    if (!list?.length) return false;
    for (const listener of list.slice()) (listener as unknown as Listener<Events[K]>)(...args);
    return true;
  }

  listenerCount(event: keyof Events): number {
    return this.listeners.get(event)?.length ?? 0;
  }
}
