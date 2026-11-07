// A minimal, runtime-agnostic subset of node:events' EventEmitter.

type Listener<Args extends unknown[]> = (...args: Args) => void;
type AnyListener = Listener<never[]>;

export class Emitter<Events extends { [K in keyof Events]: unknown[] }> {
  private readonly listeners = new Map<keyof Events, AnyListener[]>();

  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): this {
    const list = this.listeners.get(event) ?? [];
    list.push(listener as unknown as AnyListener);
    this.listeners.set(event, list);
    return this;
  }

  once<K extends keyof Events>(event: K, listener: Listener<Events[K]>): this {
    const wrapper: Listener<Events[K]> = (...args) => {
      this.off(event, wrapper);
      listener(...args);
    };
    return this.on(event, wrapper);
  }

  off<K extends keyof Events>(event: K, listener: Listener<Events[K]>): this {
    const list = this.listeners.get(event);
    const index = list?.lastIndexOf(listener as unknown as AnyListener) ?? -1;
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
