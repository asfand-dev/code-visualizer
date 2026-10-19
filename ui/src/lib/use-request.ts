import { useCallback, useEffect, useRef, useState } from 'react';

export type RequestState<T> = { status: 'idle' } | { status: 'loading' } | { status: 'done'; value: T } | { status: 'error'; message: string };

export interface RequestHandle<Args extends unknown[], T> {
  state: RequestState<T>;
  /** Starts the call; resolves to its value, or undefined when it failed (the state has the message). */
  run: (...args: Args) => Promise<T | undefined>;
  reset: () => void;
}

/**
 * Runs an async call on demand and keeps its outcome. An answer that arrives after a newer call started (or after
 * the component is gone) is dropped, so a slow search never overwrites a newer one.
 */
export function useRequest<Args extends unknown[], T>(call: (...args: Args) => Promise<T>): RequestHandle<Args, T> {
  const [state, setState] = useState<RequestState<T>>({ status: 'idle' });
  const latest = useRef(0);
  const callRef = useRef(call);
  callRef.current = call;
  useEffect(
    () => () => {
      latest.current = -1;
    },
    [],
  );

  const run = useCallback(async (...args: Args): Promise<T | undefined> => {
    const id = ++latest.current;
    setState({ status: 'loading' });
    try {
      const value = await callRef.current(...args);
      if (latest.current === id) setState({ status: 'done', value });
      return value;
    } catch (error) {
      if (latest.current === id) setState({ status: 'error', message: (error as Error).message });
      return undefined;
    }
  }, []);

  const reset = useCallback(() => {
    latest.current++;
    setState({ status: 'idle' });
  }, []);

  return { state, run, reset };
}
