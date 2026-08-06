import { useEffect, useState } from "react";
import type { PublicSwap } from "../shared/types";

export interface SwapFeed {
  swap: PublicSwap | null;
  notFound: boolean;
}

const POLL_FALLBACK_MS = 5_000;

/**
 * Live swap state: one snapshot fetch (which also detects 404 — EventSource
 * can't surface status codes), then SSE. If the stream errors, a 5s polling
 * loop covers the gap while EventSource retries; the first event or `open`
 * stops it again.
 */
export function useSwap(swapId: string): SwapFeed {
  const [swap, setSwap] = useState<PublicSwap | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (!swapId) {
      setNotFound(true);
      return;
    }

    let stopped = false;
    let source: EventSource | null = null;
    let pollTimer: number | null = null;

    const fetchOnce = async (): Promise<"ok" | "missing" | "error"> => {
      try {
        const res = await fetch(`/swap/api/${swapId}`, {
          headers: { accept: "application/json" },
        });
        if (res.status === 404) {
          if (!stopped) setNotFound(true);
          return "missing";
        }
        if (!res.ok) return "error";
        const body = (await res.json()) as PublicSwap;
        if (!stopped) setSwap(body);
        return "ok";
      } catch {
        return "error";
      }
    };

    const stopPolling = () => {
      if (pollTimer !== null) {
        window.clearInterval(pollTimer);
        pollTimer = null;
      }
    };

    const startPolling = () => {
      if (pollTimer !== null || stopped) return;
      pollTimer = window.setInterval(() => void fetchOnce(), POLL_FALLBACK_MS);
    };

    void (async () => {
      const first = await fetchOnce();
      if (stopped || first === "missing") return;
      if (first === "error") startPolling();

      source = new EventSource(`/swap/api/${swapId}/events`);
      source.addEventListener("status", (event) => {
        stopPolling();
        if (!stopped) setSwap(JSON.parse((event as MessageEvent).data) as PublicSwap);
      });
      source.onopen = () => stopPolling();
      source.onerror = () => startPolling();
    })();

    return () => {
      stopped = true;
      stopPolling();
      source?.close();
    };
  }, [swapId]);

  return { swap, notFound };
}
