import { useEffect, useState } from "react";
import QRCode from "qrcode";

/**
 * The single bright object: white block, orange frame (via .ot-qr). `size`:
 * default (216px inner), compact (176px step-down for multi-leg cards).
 *
 * We render an <img> from a data URL rather than drawing straight to a <canvas>:
 * `qrcode`'s canvas path writes an inline `style="width:…px"` sized to the
 * bitmap (592px), which overrides the stylesheet and overflows the card. An
 * <img> is never touched by the library, so the fixed sizes in ui.css win at
 * every viewport. The bitmap stays 592px for crisp downscaling.
 *
 * Module colors mirror --ot-ink / --ot-sheet — the encoder needs concrete
 * values, so these two literals live outside tokens.css by necessity.
 */
export function Qr({ value, size = "default" }: { value: string; size?: "default" | "compact" }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    QRCode.toDataURL(value, {
      width: 592, // ~2x the largest display size for crisp rendering
      margin: 2,
      color: { dark: "#0a0a0a", light: "#ffffff" },
    })
      .then((url) => {
        if (live) setDataUrl(url);
      })
      .catch(() => {
        // No canvas support (test environment) — the framed block still renders.
      });
    return () => {
      live = false;
    };
  }, [value]);

  const cls = size === "default" ? "ot-qr" : "ot-qr is-compact";
  return (
    <div className={cls} role="img" aria-label="Payment QR code">
      {dataUrl && <img src={dataUrl} alt="" />}
    </div>
  );
}
