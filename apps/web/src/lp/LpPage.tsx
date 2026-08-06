import { useEffect, useState } from "react";
import { MockBanner } from "../shared/MockBanner";
import { api, ApiError, clearKey, getStoredKey, storeKey, UNAUTHORIZED_EVENT } from "./api";
import { useHashRoute, usePolling } from "./usePolling";
import { Overview } from "./views/Overview";
import { Liquidity } from "./views/Liquidity";
import { Exposure } from "./views/Exposure";
import { History } from "./views/History";

/** LP dashboard at /lp — key-gated, hash-routed views, 5s polling. */
export function LpPage() {
  const [unlocked, setUnlocked] = useState(() => getStoredKey() !== null);

  useEffect(() => {
    // Any 401 anywhere clears the key (api.ts) and lands back on the prompt.
    const onUnauthorized = () => setUnlocked(false);
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  if (!unlocked) return <KeyPrompt onUnlocked={() => setUnlocked(true)} />;
  return (
    <Shell
      onLock={() => {
        clearKey();
        setUnlocked(false);
      }}
    />
  );
}

function GateWordmark() {
  return (
    <div className="gate-wordmark">
      Open<span className="accent">Sluice</span>
    </div>
  );
}

export function KeyPrompt({ onUnlocked }: { onUnlocked: () => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const key = value.trim();
    if (!key || busy) return;
    setBusy(true);
    setError(null);
    storeKey(key);
    try {
      await api.me(); // cheapest authenticated call — proves the key
      onUnlocked();
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? "Key rejected by the server. Enter it again."
          : "Couldn't reach the gateway.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="gate">
      <form className="gate-form" onSubmit={(e) => void submit(e)}>
        <GateWordmark />
        <p className="gate-sub">
          Liquidity provider console. Enter the LP API key you were given at
          registration (<span className="mono">slk_…</span>) — it was shown exactly once.
        </p>
        {error && <div className="gate-error">{error}</div>}
        <input
          type="password"
          className={error ? "gate-input is-error" : "gate-input"}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoFocus
          aria-label="LP API key"
        />
        <button type="submit" className="btn-primary gate-btn" disabled={!value.trim() || busy}>
          {busy ? "Checking…" : "Unlock"}
        </button>
        <div className="gate-foot">Self-hosted · your key never leaves this browser</div>
      </form>
    </div>
  );
}

const VIEW_TITLES: Record<string, string> = {
  overview: "Overview",
  liquidity: "Liquidity",
  exposure: "Exposure",
  history: "History",
};

function Shell({ onLock }: { onLock: () => void }) {
  const route = useHashRoute();
  const [adapterMode, setAdapterMode] = useState<string | null>(null);

  // The mock-settlement bar must survive gateway restarts and mode flips, so
  // it rides the same 5s poll rhythm as the data views.
  usePolling(async () => {
    try {
      const h = await api.health();
      setAdapterMode(h.adapterMode);
    } catch {
      /* health probe is best-effort; no banner if unreachable */
    }
  }, []);

  let view: React.ReactNode;
  let section: string;
  if (route.startsWith("/liquidity")) {
    view = <Liquidity />;
    section = "liquidity";
  } else if (route.startsWith("/exposure")) {
    view = <Exposure />;
    section = "exposure";
  } else if (route.startsWith("/history")) {
    view = <History />;
    section = "history";
  } else {
    view = <Overview />;
    section = "overview";
  }

  useEffect(() => {
    document.title = `OpenSluice LP — ${VIEW_TITLES[section] ?? "Dashboard"}`;
  }, [section]);

  const link = (href: string, label: string, key: string) => (
    <a href={href} className={section === key ? "nav-link active" : "nav-link"}>
      {label}
    </a>
  );

  return (
    <div className="dash">
      <aside className="dash-side">
        <a className="wordmark" href="/">
          Open<span className="accent">Sluice</span>
        </a>
        <nav className="dash-nav">
          {link("#/", "Overview", "overview")}
          {link("#/liquidity", "Liquidity", "liquidity")}
          {link("#/exposure", "Exposure", "exposure")}
          {link("#/history", "History", "history")}
        </nav>
        <div className="dash-side-foot">
          <a className="dash-market-link" href="/market">
            Marketplace →
          </a>
          <button type="button" className="lock-btn" onClick={onLock}>
            Lock
          </button>
        </div>
      </aside>
      <main className="dash-main">{view}</main>
      <MockBanner adapterMode={adapterMode} />
    </div>
  );
}
