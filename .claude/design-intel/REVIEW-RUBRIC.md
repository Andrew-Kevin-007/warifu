# Review rubric for friday's Symbolon build (jarvis REVIEW mode)

Verdicts: ELITE / NEEDS WORK / REJECTED. Defects numbered with file:line, `[open]`/`[resolved]`.

Automatic REJECTED
1. Any uniform fade-up on new pages; any `ease`/`ease-in-out`/`linear` on new motion.
2. Any decorative object that can be read as a verdict (token seated without a checked fit; seal without all-PASS status; number beside a hollow object).
3. Count-up on money, bound, rate or percentage.
4. A LOSS/not-built/N-A cell hidden, softened or omitted in the lattice.
5. Symmetric 3-up card row, glass, glow, dark purple hero, padlock/shield imagery, green success.
6. Third-party logo or invented partner/metric anywhere.

Mechanical checks (run, paste output)
- `grep -rn "style=" apps/web/src/components/design apps/web/src/components/pages apps/web/src/styles` -> none
- `grep -rniE "rapier|dangerouslySetInnerHTML|innerHTML|localStorage|document.cookie|src/wallet" ...design ...pages` -> none
- `node scripts/claims-lint.mjs` -> OK
- Curl SSR HTML of each page body: no `style="`; content readable with JS off
- DOM order of `/certificate`: exclusions -> headline -> chip -> horizons -> alarmed -> assumptions -> validation -> verify -> diff
- Reduced motion: all scenes show seated/final pose, no loop (devtools emulate)
- 4x CPU throttle: frame governor drops DPR then swaps to Still
- WebGL disabled: every page still complete, no empty rectangle
- Lighthouse a11y >= 90 on the seven Kevin pages, mobile and desktop

Taste checks
- Does each object sit beside `figure-main-*.png` without embarrassment (same periwinkle, contour weight, stipple direction)?
- One signature moment per page, screenshot-worthy?
- Is periwinkle-stipple = advisory and chrome-black = signed applied everywhere with no exception?
- Are semantic dashes (1 px, `#6E6E6E`+) never confusable with decorative dashes (0.5 px `#CCC`)?
