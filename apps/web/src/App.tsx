import { useMemo } from "react";
import { WidgetPage } from "./widget/WidgetPage";
import { ProgressPage } from "./progress/ProgressPage";
import { LpPage } from "./lp/LpPage";
import { MarketPage } from "./market/MarketPage";

/**
 * One bundle, four screens, no router dependency: the gateway serves this
 * shell at `/` (widget), `/swap/:id` (progress), `/lp` (LP dashboard) and
 * `/market` (public book); the pathname picks.
 */
export function App() {
  const path = window.location.pathname;
  const swapId = useMemo(() => {
    const match = path.match(/^\/swap\/([^/]+)\/?$/);
    return match?.[1] ?? null;
  }, [path]);

  if (swapId) return <ProgressPage swapId={swapId} />;
  if (/^\/lp\/?$/.test(path)) return <LpPage />;
  if (/^\/market\/?$/.test(path)) return <MarketPage />;
  return <WidgetPage />;
}

/** Header wordmark — text only this gate; no logo mark exists yet. */
export function Wordmark() {
  return (
    <a className="os-wordmark" href="/">
      Open<span className="accent">Sluice</span>
    </a>
  );
}
