import { useEffect, useRef, useState } from "react";

/** v2 INVERSE micro-button: COPY -> COPIED ✓ (dark fill) for 2s, then reverts. */
export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard API unavailable (http on LAN, old webview): fall back.
      const scratch = document.createElement("textarea");
      scratch.value = text;
      document.body.appendChild(scratch);
      scratch.select();
      document.execCommand("copy");
      scratch.remove();
    }
    setCopied(true);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      type="button"
      className={copied ? "btn-inverse is-active" : "btn-inverse"}
      onClick={() => void copy()}
    >
      {copied ? "COPIED ✓" : "COPY"}
    </button>
  );
}
