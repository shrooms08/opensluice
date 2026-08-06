# Screenshots

Five slots, referenced by the root `README.md`. Until a file lands here its
link in the README is broken, so fill them all or drop the reference.

| File | What the shot must show |
| --- | --- |
| `split-quote.png` | The embeddable widget with a quote split across more than one venue, so the per-venue breakdown and the combined rate are both visible. |
| `multi-leg-progress.png` | A multi-leg swap mid-flight on the progress page, with at least one leg settled and one still pending. |
| `swapped.png` | The money shot: the progress page in its final Swapped state, showing the amount received and the settlement proof. |
| `lp-exposure.png` | The LP dashboard's Exposure view, with real inventory across at least two assets and the resulting net position. |
| `marketplace.png` | The public marketplace, with several makers listed and their quotes side by side. |

## Capture settings

Use a 1440px-wide viewport at device pixel ratio 2, and crop to the content
column rather than shipping empty page margins — the app's columns cap at
380px (widget), 440px (progress), 720px (marketplace) and 1100px (LP). Capture
in the dark theme, which is the default. PNG, no window chrome, no cursor.

Use the seeded demo data (`npm run seed:demo`) so the numbers are plausible
and repeatable. Do not include real addresses, real balances, or anything from
a live wallet.
