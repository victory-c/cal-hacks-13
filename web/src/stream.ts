// Browser SSE over fetch: bearer credentials stay in a header, never a URL or server access log.

export async function readEventStream(
  stream: ReadableStream<Uint8Array>,
  receive: (type: string, data: string) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "", type = "message", data: string[] = [];
  const line = (value: string) => {
    if (!value) {
      if (data.length) receive(type, data.join("\n"));
      type = "message";
      data = [];
      return;
    }
    if (value.startsWith(":")) return;
    const colon = value.indexOf(":");
    const field = colon < 0 ? value : value.slice(0, colon);
    const content = colon < 0 ? "" : value.slice(colon + 1).replace(/^ /, "");
    if (field === "event") type = content;
    if (field === "data") data.push(content);
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        line(buffer.slice(0, end).replace(/\r$/, ""));
        buffer = buffer.slice(end + 1);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export function subscribeEvents<T>(
  server: string,
  token: string,
  types: readonly string[],
  onEvent: (event: T) => void,
  onStatus: (status: "connecting" | "live" | "reconnecting") => void,
): () => void {
  let stopped = false;
  let controller: AbortController;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const allowed = new Set(types);
  const connect = async () => {
    controller = new AbortController();
    try {
      const response = await fetch(`${server}/events`, { credentials: "same-origin", headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), accept: "text/event-stream" }, signal: controller.signal });
      if (!response.ok || !response.body) throw new Error(`Event stream returned ${response.status}`);
      if (stopped) return;
      onStatus("live");
      await readEventStream(response.body, (type, data) => {
        if (stopped || !allowed.has(type)) return;
        let event: T;
        try { event = JSON.parse(data) as T; } catch { return; }
        onEvent(event);
      });
    } catch {
      // Reconnect refetches the caller's current snapshots; malformed/disconnected streams retry.
    }
    if (!stopped) {
      onStatus("reconnecting");
      retry = setTimeout(() => void connect(), 1000);
    }
  };
  onStatus("connecting");
  void connect();
  return () => { stopped = true; controller?.abort(); if (retry) clearTimeout(retry); };
}
