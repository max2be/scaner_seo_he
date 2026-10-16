import { useCallback, useEffect, useState } from 'react';
export function useResource<T>(key: string, load: (signal: AbortSignal) => Promise<T>, poll = 0) {
  const [state, setState] = useState<{ key: string; value?: T; error?: Error; loading: boolean }>({
    key,
    loading: true,
  });
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function run() {
      if (document.hidden && poll) {
        timer = setTimeout(run, poll);
        return;
      }
      try {
        const value = await load(controller.signal);
        if (!controller.signal.aborted) setState({ key, value, loading: false });
      } catch (error) {
        if (!controller.signal.aborted)
          setState((previous) => ({
            ...previous,
            loading: false,
            error: error instanceof Error ? error : new Error('Ошибка загрузки'),
          }));
      } finally {
        if (!controller.signal.aborted && poll) timer = setTimeout(run, poll);
      }
    }
    setState((previous) =>
      previous.key === key ? { ...previous, loading: previous.value === undefined } : { key, loading: true },
    );
    void run();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
    // Callers encode all load inputs in key. Do not re-request on each render.
  }, [key, version, poll]);
  const current: typeof state = state.key === key ? state : { key, loading: true };
  return { ...current, reload };
}
export function useHash() {
  const [hash, setHash] = useState(location.hash.slice(1) || '/');
  useEffect(() => {
    const update = () => setHash(location.hash.slice(1) || '/');
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  useEffect(() => {
    document.getElementById('page-title')?.focus();
  }, [hash]);
  return hash;
}
