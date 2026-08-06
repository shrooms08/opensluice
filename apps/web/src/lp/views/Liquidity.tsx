import { useState } from "react";
import type { LpMe, Marketplace, MarketplaceEntry, SwapDirection } from "../../shared/types";
import { api, type LiquidityOffer } from "../api";
import { usePolling } from "../usePolling";

interface OfferDraft {
  capacitySats: string;
  feeBps: string;
  feeFixedSats: string;
  minSats: string;
  maxSats: string;
  estSeconds: string;
}

const FRESH_DRAFT: OfferDraft = {
  capacitySats: "100000",
  feeBps: "25",
  feeFixedSats: "0",
  minSats: "1000",
  maxSats: "100000",
  estSeconds: "60",
};

function draftFrom(me: LpMe, direction: SwapDirection): OfferDraft | null {
  const config = direction === "swap_in" ? me.liquidity.swapIn : me.liquidity.swapOut;
  if (!config) return null;
  return {
    capacitySats: config.capacitySats,
    feeBps: String(config.feeBps),
    feeFixedSats: config.feeFixedSats,
    minSats: config.minSats,
    maxSats: config.maxSats,
    estSeconds: String(config.estSeconds),
  };
}

function toOffer(draft: OfferDraft): LiquidityOffer {
  return {
    capacitySats: draft.capacitySats.trim(),
    feeBps: Number(draft.feeBps),
    feeFixedSats: draft.feeFixedSats.trim(),
    minSats: draft.minSats.trim(),
    maxSats: draft.maxSats.trim(),
    estSeconds: Number(draft.estSeconds),
  };
}

/**
 * Rank in the live book if this draft were published: the same ordering the
 * router drains — feeBps, then fixed fee, then est. time, then lpId — among
 * providers with availability. Computed client-side from /api/marketplace.
 */
export function bookPosition(
  entries: MarketplaceEntry[],
  lpId: string,
  draft: OfferDraft,
): { rank: number; of: number } | null {
  const live = entries.filter((e) => BigInt(e.availableSats) > 0n || e.lpId === lpId);
  if (!live.some((e) => e.lpId === lpId)) return null;
  const projected = live.map((e) =>
    e.lpId === lpId
      ? {
          ...e,
          feeBps: Number(draft.feeBps) || 0,
          feeFixedSats: /^\d+$/.test(draft.feeFixedSats) ? draft.feeFixedSats : "0",
          estSeconds: Number(draft.estSeconds) || 0,
        }
      : e,
  );
  projected.sort(
    (a, b) =>
      a.feeBps - b.feeBps ||
      (BigInt(a.feeFixedSats) < BigInt(b.feeFixedSats)
        ? -1
        : BigInt(a.feeFixedSats) > BigInt(b.feeFixedSats)
          ? 1
          : 0) ||
      a.estSeconds - b.estSeconds ||
      a.lpId.localeCompare(b.lpId),
  );
  return { rank: projected.findIndex((e) => e.lpId === lpId) + 1, of: projected.length };
}

export function Liquidity() {
  const [me, setMe] = useState<LpMe | null>(null);
  const [market, setMarket] = useState<Marketplace | null>(null);
  const [error, setError] = useState<string | null>(null);
  // null = not initialized from the server yet; polls never clobber edits.
  const [drafts, setDrafts] = useState<{ [K in SwapDirection]: OfferDraft | null } | null>(null);

  usePolling(async () => {
    try {
      const [m, mk] = await Promise.all([api.me(), api.marketplace()]);
      setMe(m);
      setMarket(mk);
      setDrafts(
        (current) =>
          current ?? {
            swap_in: draftFrom(m, "swap_in"),
            swap_out: draftFrom(m, "swap_out"),
          },
      );
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  return (
    <div className="view">
      <div className="view-head">
        <h1 className="view-title">Liquidity</h1>
      </div>
      {error && <p className="banner-error">{error}</p>}
      {me && drafts ? (
        <>
          <DirectionEditor
            direction="swap_in"
            title="Swap-in offer"
            sub="You front off-chain sats from your vault; the user's on-chain deposit repays you."
            me={me}
            entries={market?.swapIn ?? []}
            draft={drafts.swap_in}
            onDraft={(d) => setDrafts({ ...drafts, swap_in: d })}
          />
          <DirectionEditor
            direction="swap_out"
            title="Swap-out offer"
            sub="You front on-chain sats; the user's off-chain payment repays you."
            me={me}
            entries={market?.swapOut ?? []}
            draft={drafts.swap_out}
            onDraft={(d) => setDrafts({ ...drafts, swap_out: d })}
          />
        </>
      ) : (
        <div className="skel-rows">
          <div className="skel" style={{ width: "60%" }} />
          <div className="skel" style={{ width: "85%" }} />
        </div>
      )}
    </div>
  );
}

const FIELDS: Array<{ key: keyof OfferDraft; label: string; mono: boolean }> = [
  { key: "capacitySats", label: "Capacity (sats)", mono: true },
  { key: "feeBps", label: "Fee (bps)", mono: true },
  { key: "feeFixedSats", label: "Fee fixed (sats)", mono: true },
  { key: "minSats", label: "Min (sats)", mono: true },
  { key: "maxSats", label: "Max (sats)", mono: true },
  { key: "estSeconds", label: "Est. seconds", mono: true },
];

export function DirectionEditor({
  direction,
  title,
  sub,
  me,
  entries,
  draft,
  onDraft,
}: {
  direction: SwapDirection;
  title: string;
  sub: string;
  me: LpMe;
  entries: MarketplaceEntry[];
  draft: OfferDraft | null;
  onDraft: (draft: OfferDraft) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);

  const save = async () => {
    if (!draft || saving) return;
    setSaving(true);
    setSaveError(null);
    // Optimistic: the draft already shows the new values; on failure we
    // revert to what the server last confirmed.
    try {
      const body =
        direction === "swap_in" ? { swapIn: toOffer(draft) } : { swapOut: toOffer(draft) };
      await api.putLiquidity(body);
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 2000);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
      const reverted = draftFrom(me, direction);
      if (reverted) onDraft(reverted);
    } finally {
      setSaving(false);
    }
  };

  const position = draft ? bookPosition(entries, me.id, draft) : null;

  return (
    <section className="liq-card">
      <div className="liq-head">
        <div>
          <h2 className="liq-title">{title}</h2>
          <p className="liq-sub">{sub}</p>
        </div>
        {draft && (
          <button
            type="button"
            className="btn-primary"
            disabled={saving}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : savedFlash ? "Saved ✓" : "Save"}
          </button>
        )}
      </div>

      {saveError && <p className="banner-error">{saveError}</p>}

      {draft ? (
        <>
          <div className="liq-grid">
            {FIELDS.map((f) => (
              <label className="liq-field" key={f.key}>
                <span>{f.label}</span>
                <input
                  className={f.mono ? "ot-input mono" : "ot-input"}
                  inputMode="numeric"
                  autoComplete="off"
                  value={draft[f.key]}
                  aria-label={`${title} — ${f.label}`}
                  onChange={(e) => onDraft({ ...draft, [f.key]: e.target.value })}
                />
              </label>
            ))}
          </div>
          <div className="liq-position mono">
            {position
              ? `Your position in the ${direction === "swap_in" ? "swap-in" : "swap-out"} book: #${position.rank} of ${position.of}${position.rank === 1 ? " · best rate" : ""}`
              : "Not currently ranked — the book only lists providers with available capacity."}
          </div>
        </>
      ) : (
        <div className="liq-empty">
          <p className="muted">No {direction === "swap_in" ? "swap-in" : "swap-out"} offer published yet.</p>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => onDraft({ ...FRESH_DRAFT })}
          >
            Draft an offer
          </button>
        </div>
      )}
    </section>
  );
}
