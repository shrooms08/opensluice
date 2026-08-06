/**
 * OpenSluice logo — canonical geometry from design/OpenSluice_Mark.html
 * (concept A: the raised gate blade, water stepping down through the opening).
 * Do not alter the shapes, the 1.5-unit open gap, or the color rules. Inline
 * SVG only (~180 bytes of paths); colors come from the CSS tokens.
 *
 * Family logic: OpenTill is value dropping into an open till; OpenSluice is
 * the gate raised so value moves between levels. Orange is always the element
 * in motion (there, the coin; here, the blade), the receiving structure always
 * takes text-color, and both marks keep the identical 1.5-unit open gap.
 */

/** Standard mark, viewBox 0 0 24 24. */
const STD = {
  water: "M3 12h6v3h12v6H3z",
  blade: { x: 9.5, y: 3, w: 3, h: 7.5 },
};

/**
 * Small-size variant (≤16px rendered) — optical compensation only: the blade
 * widens 3→4, the water grows 0.5 outward and its step deepens to 4, and the
 * gap still holds ≥1.5 so the "open" read survives 1-bit rendering.
 */
const SMALL = {
  water: "M2.5 11.5h6.5v4H21.5v6H2.5z",
  blade: { x: 9, y: 2, w: 4, h: 8 },
};

export interface LogoMarkProps {
  /** Rendered size in px (square). ≤16 switches to the small-variant paths. */
  size?: number;
  /** Light surface: water uses --ot-ink instead of --ot-text. Blade stays accent. */
  onLight?: boolean;
  /** Single-color contexts: both shapes take this CSS color (e.g. a var()). */
  singleColor?: string;
}

export function LogoMark({ size = 24, onLight = false, singleColor }: LogoMarkProps) {
  const g = size <= 16 ? SMALL : STD;
  const blade = singleColor ?? "var(--ot-accent)";
  const water = singleColor ?? (onLight ? "var(--ot-ink)" : "var(--ot-text)");
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      style={{ display: "block", flexShrink: 0 }}
    >
      <path d={g.water} fill={water} />
      <rect x={g.blade.x} y={g.blade.y} width={g.blade.w} height={g.blade.h} fill={blade} />
    </svg>
  );
}

export interface LogoLockupProps {
  /** Mark height in px. Below the 20px lockup minimum, the mark renders alone. */
  size?: number;
  onLight?: boolean;
}

/**
 * Horizontal lockup: gap = 0.32 × mark height, wordmark cap height = 0.78 ×
 * mark height with its baseline on the water's bottom edge (the water bottom
 * sits 3/24 of the mark above its box; Space Grotesk cap ≈ 0.7em, descent
 * ≈ 0.2em — the inline styles below encode that math). Clear space is
 * 0.5 × mark height on all sides, applied by the consuming layout.
 */
export function LogoLockup({ size = 24, onLight = false }: LogoLockupProps) {
  if (size < 20) return <LogoMark size={size} onLight={onLight} />;

  const fontSize = (0.78 * size) / 0.7; // cap height ≈ 0.78 × mark height
  const waterBottom = (3 / 24) * size; // water bottom offset from the mark's box
  const descent = 0.2 * fontSize; // approx Space Grotesk descender
  return (
    <span
      className="os-lockup"
      style={{ display: "inline-flex", alignItems: "flex-end", gap: 0.32 * size }}
    >
      <LogoMark size={size} onLight={onLight} />
      <span
        style={{
          font: `700 ${fontSize}px var(--ot-font-display)`,
          letterSpacing: "-0.03em",
          lineHeight: 1,
          color: onLight ? "var(--ot-ink)" : "var(--ot-text-hero)",
          // Baseline (line box bottom − descent) sits on the water bottom.
          marginBottom: waterBottom - descent,
          whiteSpace: "nowrap",
        }}
      >
        Open<span style={{ color: "var(--ot-accent)" }}>Sluice</span>
      </span>
    </span>
  );
}
