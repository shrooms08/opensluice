import { useEffect, useState } from "react";
import { truncateId } from "../shared/format";
import { ProgressView } from "./ProgressView";
import { useSwap } from "./useSwap";

export function ProgressPage({ swapId }: { swapId: string }) {
  const { swap, notFound } = useSwap(swapId);
  const [payingLeg, setPayingLeg] = useState<number | null>(null);

  useEffect(() => {
    document.title = `Swap — ${truncateId(swapId)} · OpenSluice`;
  }, [swapId]);

  const onPayLeg = async (index: number) => {
    setPayingLeg(index);
    try {
      await fetch(`/dev/swaps/${swapId}/pay-leg/${index}`, { method: "POST" });
      // No state handling needed: the resulting transition arrives over SSE.
    } finally {
      setPayingLeg(null);
    }
  };

  return (
    <div className="pg-page">
      <ProgressView
        swap={swap}
        notFound={notFound}
        onPayLeg={(i) => void onPayLeg(i)}
        payingLeg={payingLeg}
      />
    </div>
  );
}
