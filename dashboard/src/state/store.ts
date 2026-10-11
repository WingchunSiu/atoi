import { useCallback, useSyncExternalStore } from "react";

/** A minimal external store for useSyncExternalStore. */
export interface Store<T> {
  get(): T;
  set(next: Partial<T> | ((prev: T) => Partial<T>)): void;
  subscribe(listener: () => void): () => void;
}

export function createStore<T extends object>(initial: T): Store<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next) {
      const patch = typeof next === "function" ? next(value) : next;
      value = { ...value, ...patch };
      for (const l of listeners) l();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Subscribe to a slice of any store with a get/subscribe pair. The selector must return stable values. */
export function useStore<T, S>(
  store: { get(): T; subscribe(l: () => void): () => void },
  selector: (v: T) => S,
): S {
  const get = useCallback(() => selector(store.get()), [store, selector]);
  return useSyncExternalStore(store.subscribe, get, get);
}
