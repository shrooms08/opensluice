import { createRoot } from "react-dom/client";
import "./shared/fonts.css";
import "./shared/tokens.css";
import "./shared/ui.css";
import "./widget/widget.css";
import "./progress/progress.css";
import "./lp/lp.css";
import "./market/market.css";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(<App />);
