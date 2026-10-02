import { useEffect, useMemo, useState } from "react";
export interface ResourceState<T> {
  status: "empty" | "loading" | "fresh" | "stale" | "error";
  data: T | null;
  error: string | null;
  fetchedAt: number | null;
  pending: boolean;
}
export class ResourceController<T> {
  state: ResourceState<T> = {
    status: "empty",
    data: null,
    error: null,
    fetchedAt: null,
    pending: false,
  };
  private generation = 0;
  private abort: AbortController | undefined;
  constructor(
    private readonly changed: (state: ResourceState<T>) => void = () => {},
  ) {}
  private publish(value: ResourceState<T>) {
    this.state = value;
    this.changed(value);
  }
  clear() {
    this.generation++;
    this.abort?.abort();
    this.publish({
      status: "empty",
      data: null,
      error: null,
      fetchedAt: null,
      pending: false,
    });
  }
  async load(loader: (signal: AbortSignal) => Promise<T>) {
    this.abort?.abort();
    const generation = ++this.generation;
    const abort = new AbortController();
    this.abort = abort;
    this.publish({
      ...this.state,
      status: this.state.data ? "stale" : "loading",
      error: null,
      pending: true,
    });
    try {
      const data = await loader(abort.signal);
      if (generation !== this.generation || abort.signal.aborted) return;
      this.publish({
        status: "fresh",
        data,
        error: null,
        fetchedAt: Date.now(),
        pending: false,
      });
    } catch (error) {
      if (generation !== this.generation || abort.signal.aborted) return;
      const code = error instanceof Error ? error.message : "unavailable";
      if (code === "unauthenticated") {
        this.clear();
        return;
      }
      this.publish({
        ...this.state,
        status: this.state.data ? "stale" : "error",
        error: code,
        pending: false,
      });
    }
  }
  dispose() {
    this.generation++;
    this.abort?.abort();
  }
}

export function useOperatorResource<T>(
  scope: string | null,
  loader: (signal: AbortSignal) => Promise<T>,
) {
  const [snapshot, setSnapshot] = useState<{
    scope: string | null;
    state: ResourceState<T>;
  }>({
    scope: null,
    state: {
      status: "empty",
      data: null,
      error: null,
      fetchedAt: null,
      pending: false,
    },
  });
  const resource = useMemo(
    () => new ResourceController<T>((state) => setSnapshot({ scope, state })),
    [scope],
  );
  useEffect(() => {
    if (scope) void resource.load(loader);
    else resource.clear();
    return () => resource.dispose();
  }, [resource, loader, scope]);
  return {
    state: snapshot.scope === scope ? snapshot.state : resource.state,
    refresh: () => void resource.load(loader),
  };
}
