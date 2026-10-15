# Symbolon: whole-site design brief (jarvis -> friday)

Author: jarvis (creative direction). Builder: friday. Date: 2026-10-14. Binding for the UI layer; `AGENTS.md` and `docs/WEB_PAGES_PLAN.md` outrank it where they conflict (flag the conflict in `docs/QUESTIONS.md`, do not guess).
Base: `worktree-integration-final` @ 832bfa6. Read-only inputs: `apps/web/src/app/{globals,additions}.css`, `apps/web/src/components/**`, `apps/web/public/**`, `docs/WEB_PAGES_PLAN.md`, `docs/11`, `docs/15`, `docs/16`, `results/attack-matrix.json`, `packages/schemas/src/{lbc,challenge}.ts`.

> Intel disclosure. I could not refresh the two anchor sites live this run (no web-fetch tool in this session; shell network call was denied by the permission layer) and could not drain the design-memory queue (its three transcripts belong to a different project, `d:\page_content`, and reading them was blocked). So the anchors below are cited from standing memory, not today's state, and the bar is the same: landonorris.com (scroll as narrative, type fused with 3D) and wings.design (disciplined palette, personality in micro-interaction). Everything in this brief that is a statement about Kevin's site was read from its real code and assets this run.

---

## 0. The idea in one paragraph

Symbolon is a Greek tally token: an object snapped in two, each party keeping a half, and the halves prove the agreement only because their broken edges fit nothing else. That is the product. The agent's payment proposal is one half. The owner-and-payee signed engagement plus kernel-collected evidence is the other. The kernel's job is to check whether the fracture lines match; the vault only moves money for halves that fit; the receipt is the seal made when they do. Every page of the site is a view of that one object: **a fit, a non-fit, or a fit nobody has checked yet.**

Emotional target: cold, exact, a little ceremonial. A calm instrument that has seen the attack and is not impressed. Not "secure!" and not "AI!" — *inspected*.

Signature moment of the site (the screenshot): on `/`, scrolling through "From invoice to receipt" assembles the token: the periwinkle proposal half and the black chrome engagement half drift together, the fracture is scanned edge by edge by the checks, they seat with a snap, and a receipt seal stamps. On `/judge` card 1 the same halves **refuse to seat** while the agent has been fooled and the money does not move.

---

## 1. Design-language extraction (what makes it THIS site)

Everything below was read from the compiled CSS and components. Reuse these; anything new must be derivable from them.

### 1.1 The look in eight rules

1. **White specimen plate.** Page ground is `#FFFFFF`; ink is `#000000`. One object per plate, centered, big, nothing competing. Never a dark page background (the footer is the only black region, and it is a deliberate bottom-of-page inversion).
2. **Ink-and-stipple objects.** Every hero object in `public/media/*.png` is one flat periwinkle (`#9280FC`), a 1 px black contour, white stipple dots toward the light, black stipple dissolving into solid black toward the shadow. No gradients on objects, no glow, no specular. This is the single most distinctive thing about the site. New 3D objects must read as siblings of `figure-main-*.png` and `stack-figure-*.png` when placed beside them.
3. **Chrome only on black.** The footer tetrapods use `matcap.png` (monochrome chrome). Chrome is the "hard, physical" material and lives on black surfaces and `card-black`.
4. **Dashed construction grid.** Sections are framed by 0.5 px dashed hairlines (`stroke #CCCCCC`, `stroke-dasharray 4 2`) with small white circular nodes (`r=3`, `fill #fff`, `stroke #CCCCCC .5`) at every intersection (`PageGrid.tsx`, `HeroGridSvg.tsx`, `footer-grid.svg`). Decorative only.
5. **Stair silhouette.** The hero's `clip-path` is a stepped pyramid (steps about 120 px wide by 90-100 px high). Steps, not curves, are the site's geometric accent. The fracture on our token is therefore orthogonal and stepped, not organic.
6. **Quiet type, one family.** Inter only (self-hosted `inter-latin.woff2`; `Roobert` is an alias of the same file, weights 500/600). Large headings use `gradient-text-black` (black to `#606060`), centered, narrow measure (610-680 px), preceded by a `body-text-s` eyebrow. Sentence case. Declarative sentences. Arrows are written `->` in link text.
7. **Engineered buttons and chips.** 1 px gradient-bordered wrapper + inner fill, double soft shadow, radii 5.5/7.5/9.5 (xs/s/m-l). Tags are `small-tag` pills (radius 24, 3 px `#F9F9F9` ring). Nothing is flat-rounded-the-same.
8. **Slow settle, quick start.** The signature ease is `cubic-bezier(0, 0.35, 0.15, 1)` at 500 ms (1400 ms on hover scale): fast departure, long landing. Used on every hovered figure (`group-hover:scale-110`).

### 1.2 Tokens (verified present in `globals.css`)

| Group | Token / class | Value |
|---|---|---|
| Ink | black / `#232323` (button fill) / `#3C3C3C` (button hover) | 21:1 / 15.7:1 on white |
| Grays | `text-gray-1000` `#6E6E6E` (body-muted), `gray-900` `#878787`, `gray-800` `#939393` (on black), `gray-700` `#C9C9C9`, `gray-600` `#DFDFDF`, `gray-500` `#E9E9E9` (hairline borders), `gray-400` `#F4F4F4` (nav tray), `gray-300` `#F9F9F9` | see 5.3 for contrast |
| Accent | `primary` `#9280FC` (periwinkle, objects, lines); `cta` lavender `#D5ABFF` (CTA button fill, hover text on black); gradient end-stops `#C966FF`/`#C16AFF`; button-cta border `#E0C0FF -> #CDA2F9`; `gradient-text-soon` `#9280FC -> #C966FF` | one accent family |
| Wallet purple | `#8644F7` (`button-connect`) | wallet button only; never a design accent |
| Fills | `card-light` gradient `#EDEDED -> #E5E5E5`; stack item `#E2DDFC -> #FAFAFA` (200deg); `card-black` `#000` / text `#939393`; `section-top-shadow` radial `#F1F1F1` | |
| Type | `heading-hero` 40->74, `h1` 36->64, `h2` 32->52, `h3` 28->46, `h4` 24->32, `h5` 22->28, `h6` 20->24 (fluid `calc()`, 320 -> 1460 px viewport, line-height 120-130%, tracking -.02em/-.01em); `body-text-l` 18/140, `m` 16/150, `s` 15/140, `xs` 14, `xxs` 13 | weights 500 (hero/h1/h2), 600 (h3-h6) |
| Spacing | `xxs 4, xs 8, sm 16, md 24, lg 32, xl 40, xxl 48` + `64px, 80px, 96px, 120px, [140px]`; `section-margin/padding` 80 -> 120 at lg | |
| Radii | `rounded-6/8/10/12/16/24`, `rounded-full` | cards 10 or 16, pills 24 |
| Containers | `.container` max 576/768/1000/1300/1460 with `max(5%,16px)` side padding; page bodies cap at `max-w-[848px]` (cards) / `[1024px]` (grids) / `[760px]` (prose-with-figure) | |
| Breakpoints | 576, 768, 1000 (`lg`), 1300, 1460, 1980 | there is no `sm: 640`; do not assume stock Tailwind |
| Motion in use | `duration-200` buttons, `300` swaps, `500` fades/figures, `700` fades, `1400` figure hover; `flying` 5 s ease-in-out infinite (translateY 0->5 px->0); `animate-dasharray` 8 s linear; footer path-draw 0.5 s easeInOut staggered 0.2 s; hero slide swap 0.3-0.4 s opacity; pointer lean `power2.out` 1.7 s + `elastic.out(1.2,0.4)` return | |

### 1.3 Reusable patterns (class names to reuse verbatim)

- Page frame: `SiteShell` (`global-wrapper`, Header, Footer).
- Section scaffold: `<section class="section-x relative my-80px lg:my-[...] overflow-hidden"><div class="container">` + optional `<div class="section-top-shadow"/>`.
- Eyebrow + heading: `body-text-s` over `heading-h1 gradient-text-black` (or `heading-hero` on first section of a page), centered, `max-w-[610px]`.
- Cards: `card-black` / `card-light` outer with `p-[0.5px] rounded-[16px]`, inner `card-stack__item rounded-16`, figure absolutely placed, hover `scale-110` on the `ease-[cubic-bezier(0,0.35,0.15,1)]` curve.
- Buttons: `button-primary-{xs,s,m,l}__wrapper` + `button-primary-*`, `button-ghost-*`, `button-cta-*`, `button-chart-*`.
- List rows: `positions__item border-b border-gray-500 pb-sm` + `heading-h5` + `small-tag-wrapper/small-tag/small-tag-inner`, hover `translate-x-sm` and the arrow mask icon.
- Header nav tray: `bg-gray-400 rounded-[9px] p-[4px]` with `tab-wrapper-m is-reversed`.

### 1.4 Hard warning: the CSS is a frozen Tailwind build

`globals.css` is a pre-compiled bundle (no Tailwind JIT in the repo; `additions.css` exists precisely because the original bundle "did not compile" some classes). **A Tailwind class that is not already in `globals.css` or `additions.css` will silently do nothing.** friday must:

1. Before using any utility class, `grep -c "\.the-class" apps/web/src/app/globals.css apps/web/src/app/additions.css`. Arbitrary-value classes are only present if the exact string was compiled.
2. Put every new rule in `apps/web/src/styles/design.css` (and siblings) under the prefix `.sy-` and `--sy-*` custom properties. Do not edit `globals.css` / `additions.css` (they are under `app/**`).
3. Import `design.css` from `components/design/DesignRoot.tsx` (global CSS may be imported from any component in the App Router). Every page body wraps itself in `<DesignRoot>`.

### 1.5 What this site is NOT (so nothing new feels foreign)

No dark hero, no glassmorphism, no neon/bloom, no particle fields, no gradient mesh backgrounds, no emoji, no icon-in-circle feature rows, no stock security imagery (padlocks, shields, checkmark badges), no green "success" language, no pie/donut charts, no third-party marks. The existing home does use a 3-up icon/title/text row (`SectionOneClickDeployment`) and a uniform opacity `Reveal`; those are Kevin's and stay, but **new pages do not copy them**.

### 1.6 Template residue found in Kevin's pages (hand to Kevin / web lane; friday must not copy it and cannot edit it)

| # | Where | Problem | Owner |
|---|---|---|---|
| R1 | `components/home/SectionPartnersLine.tsx`, `SectionPoweredBy.tsx`, `SectionAgentFrameworks.tsx`, `about/SectionPartners.tsx` | Third-party logos (Gate.io, Bybit, Solana Foundation, Nvidia, OpenAI, DeepSeek, Claude, Anthropic, Gemini, Sona, Akira, Eliza, Rig, MEXC, Bitpanda). Violates "no third-party logos or invented partners". | web lane / Kevin; kit supplies `AttackMatrixBlock` and `PilotStatsBlock` as replacements (5.1) |
| R2 | `public/media/market-image.8bac8775.png` | Raster has the text "AI AGENT 694" baked in. Reads as an invented metric. | Kevin: crop or replace |
| R3 | `Header.tsx` | Nav = About / TGPT / Sona / Research / Staking / AI Market; "Connect Wallet" -> `/console`. | web lane (plan section 6) |
| R4 | `Footer.tsx` | Template links (`/manifesto`, `/tokenomics`, `/ai-market`...), `discord.gg/symbolon`, `x.com/symbolonprotocol`, `t.me/symbolon_pro`, external `symbolon.pro/*`; "Symbolon AI (c) 2026". Handles look invented. | web lane / Kevin |
| R5 | `Footer.tsx` -> `FooterFigures.tsx` | Loads r3f + **rapier (wasm)** + `matcap.png` + `tetrapod_v1.glb` on every page via `SiteShell`. Breaks SEC-06 on the challenge origin and ships physics on pages that do not need it. Kit supplies `FooterTetrapodsStill` as the profile-gated replacement. | web lane + SEC |
| R6 | 18 `style=` attributes (`Footer`, `Header`, `SectionFeaturesGrid`, `SectionCareers`, `Reveal`) and framer-motion SSR inline `opacity:0` | CSP `style-src` has no `unsafe-inline`; lint bans inline style. Kit supplies `Appear` (class-toggle reveal) and mask-icon classes to replace them. | web lane |
| R7 | `Hero.tsx` slide links `/ai-market`, `/search`, `/staking`; `SectionGateway` links same | Dead routes. | web lane |
| R8 | `layout.tsx` `metadataBase localhost:3000`, `themeColor #ffffff` | Needs the deployed origin. | web lane |
| R9 | `Hero.tsx` `<video autoPlay muted>` without `playsInline`, no pause under reduced motion | craft floor | Kevin / web lane |

---

## 2. Brand motif and object family

### 2.1 The system: two materials, three surface states

**Materials carry meaning. Use them consistently or the site lies.**

| Material | Looks like | Means | Where it appears |
|---|---|---|---|
| **Stipple periwinkle** (`#9280FC`, ink contour, white/black dot shading) | soft, grainy, drawn | agent output, proposals, attacker payloads, anything advisory | proposal half, attack tiles, the wave |
| **Chrome black** (`matcap.png`, ink contour) | hard, reflective, heavy | signed, deterministic, on-chain: engagement terms, kernel verdicts, the vault | engagement half, kernel caps, vault drum, footer tetrapods |

| Surface state | Visual | Means |
|---|---|---|
| **Solid** (filled object, solid 1 px ink border) | | checked / fit / VALID |
| **Dashed** (1 px dashed `#6E6E6E` or `#232323`, or hatch fill) | | not verified, untrusted, simulated, stale, quarantined |
| **Hollow** (contour only, no fill, no stipple) | | no claim is being made (UNVERIFIED, not computed, empty, not built) |

Rule: **decorative dashes are 0.5 px `#CCCCCC`; semantic dashes are 1 px `#6E6E6E` or darker.** They must never be confusable. Rule: **hollow = no number.** A hollow object never sits beside a figure presented as a result.

### 2.2 The family

All objects: procedural, pure `three` (named imports, no r3f reconciler required, no rapier, no wasm), the **InkStipple** shader for periwinkle, `MeshMatcapMaterial` with `/matcap.png` for chrome, inverted-hull ink outline on both. Every object has a DOM **Still** (inline SVG/CSS, no WebGL) used for reduced-motion, low power, no WebGL, challenge-origin `/`, print, and first paint.

| # | Object | Meaning | Geometry approach | Lives on | Interaction | Still |
|---|---|---|---|---|---|---|
| 1 | **TallyToken** (the symbol) | A payment proposal meeting its engagement | Disc R=1, depth 0.26, bevel 0.015, split along an orthogonal **step fracture** (7 steps, amplitudes `[+.12,-.08,+.16,-.12,+.08,-.16,+.12]*R`, matching edge is the same polyline negated; mismatch variant shifts steps 2 and 5 by +/-0.07R). Built from two `ExtrudeGeometry` shapes (circle polygon, 64 pts, clipped by the polyline). Half A = stipple periwinkle ("Proposal"). Half B = chrome black ("Engagement"). Poses: `apart`, `approach`, `scan`, `seated`, `mismatch`, `hollow`. | `/` (scroll assembly), `/judge`, `/pilot` (empty plate), `/engagements/*` (state icon), 404/error | pointer lean +/-8 deg Y, +/-5 deg X (1.2 s settle, ease-settle); scroll-linked assembly (5.1); keyboard: none (decorative) | `TallyTokenStill`: two SVG paths + dot pattern |
| 2 | **VaultDrum** | The bounded container | Hollow drum (outer R 1, inner R .72, height .5) with up to 3 concentric **cap rings** (perTx, daily, hourly) as raised chrome arcs; arc angle = cap ratio of balance via basis points; open top shows a periwinkle core (balance). Echoes `stack-figure-5` ring + bars. | `/dashboard`, `/certificate` header (small), `/blast-radius` | slow turn 0.04 rad/s; hover lifts the ring under the cursor and shows its DOM label | `VaultDrumStill` |
| 3 | **ReceiptSeal** | A decision that was checked | Thin disc (R .8, depth .08) with **32 radial ticks** on a ring; tick length = byte value of the 32-byte hash (deterministic fingerprint), so one flipped byte visibly changes one tick. Chrome. | `/audit/[hash]`, `/judge` card 2, `/replay`, home signature moment (stamp) | stamp-down 420 ms ease-snap on mount; no hover | `ReceiptSealStill` (32 `<line>`s) |
| 4 | **AttackLattice** | 24 attacks x 4 targets | `InstancedMesh`, one tile per cell (96 at current data; count comes from data). Per cell: periwinkle tile (the payload); outcome decides the cap (see 2.3). Camera orthographic, 3/4 view, rows = targets, columns = attacks. | `/attack-lab` header band; compact DOM variant on `/` and `/challenge` | hover/focus a table row or column lights the matching lattice column/row (shared `LatticeFocus` context); pointer raycast shows a DOM tooltip, never canvas text | `AttackLatticeGrid` (DOM/CSS grid, **the primary accessible control**; canvas is skin) |
| 5 | **HorizonSteps** | The bound at each horizon | Stair of slabs, one per horizon (`horizons[]`), slab height = `value / balance` as basis points (never a raw bigint -> Number), a transparent ceiling plane at balance, the `binding` term's slab outlined 2 px. Echoes the hero's stepped clip-path. | `/certificate/[vault]` beside the table, `/judge` card 3, `/blast-radius` | hover slab -> DOM row highlight; what-if sliders re-extrude with 300 ms ease-settle and the plate flips to SIMULATED hatch | `HorizonStepsStill` |
| 6 | **TetrapodWall** | Absorbing, not stopping: the blast radius | Kevin's `tetrapod_v1.glb` (node `Cylinder004`), 9-15 instances in a staggered breakwater row, **no physics**; rendered InkStipple on white, chrome matcap on black. Attack wave = reused `waveShaders` plane in the same periwinkle. | `/challenge` hero, `/blast-radius`, footer (still) | wave rises on each attempt result (event-driven, 1.2 s), tetrapods nudge with the pointer spring | `TetrapodStill` (reuse `figure-main-ai-console.c850f2f4.png` x3 + CSS) |

Why tetrapods: a breakwater piece absorbs a wave rather than refusing it, which is exactly "bounded loss". It is also the asset Kevin already owns.

### 2.3 Lattice cell grammar (2D and 3D identical)

Source vocabulary is the real `attack-matrix/1` file: outcomes `BLOCKED | ESCALATED | HELD | LOSS | NOOP | NOT_RUN`, applicability `true|false`, scoring `oracle|signal`, target status `run | not-built`.

| Cell | 3D | DOM Still | Text label (always present) |
|---|---|---|---|
| BLOCKED | periwinkle tile + black chrome cap seated | tile + solid black top bar | `Blocked` |
| ESCALATED | tile + cap tilted 20 deg, half seated | tile + half bar | `Escalated` |
| HELD | tile + dashed ghost cap | tile + dashed bar | `Held` |
| LOSS | tile raised, `#B42318` flat fill, no cap, ink contour | solid `#B42318` | `Loss` |
| NOOP | tile, no cap, no fill change, hollow | contour only | `No effect` |
| N/A | empty socket (recessed, hollow) | dotted outline | `Not applicable` + reason on focus |
| NOT_RUN / target `not-built` | whole row hatched ghost, hollow | diagonal hatch | `Not run` / `Not built yet` |

The matrix currently contains an oracle-scored loss for Symbolon and two targets not built (B0, B2). **Render exactly what the file says.** A LOSS cell on the Symbolon row must look as real as any other; never omit, soften, or let the lattice read as all-clear. Signal-scored rows carry a visible `signal` tag (they are not oracle-scored).

### 2.4 2D motif primitives (cheap, everywhere, DOM-only)

- **FractureRule**: a section divider = 0.5 px dashed `#CCCCCC` line with one orthogonal 8 px step in the middle (the fracture), drawn left-to-right with a path-draw (existing footer easing). Replaces plain `<hr>` on all new pages.
- **NodeFrame**: a dashed hairline rectangle with `r=3` white nodes at the corners/mid-edges. The container for figures and cards on new pages.
- **FractureWord**: at most one per page. A heading word is rendered twice (`::after` with `content: attr(data-text)`, `aria-hidden` semantics preserved by the real text node) and clipped by complementary stepped `clip-path` polygons, offset 3 px, closing to 0 over 700 ms on load (ease-snap). Reduced motion: rendered closed. This is the "type fused with the object" gesture.
- **Plate**: figure + mono caption "FIG. 02 / TALLY, PROPOSAL HALF" (figure numbers are structural, assigned in code order, not metrics).

### 2.5 Type additions (minimal)

Only one new face-level decision: hashes, receipts, commands, check IDs and K-codes use the system mono stack already in the reset (`ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas`), 13/14 px, `font-variant-numeric: tabular-nums`, 0.01em tracking. No new font file. Numerals in headline stats use Inter with `tabular-nums` (verify the shipped subset supports `tnum`; if it does not, set big stat numerals in the mono stack at heading-h1 size and say so in the PR).

---

## 3. Motion system

### 3.1 Tokens (`styles/design.css`, all as custom properties)

```
--sy-ease-settle: cubic-bezier(0, .35, .15, 1);     /* the site's signature; figures, objects, reveals of things */
--sy-ease-ui:     cubic-bezier(.4, 0, .2, 1);       /* buttons, tabs (existing) */
--sy-ease-snap:   cubic-bezier(.34, 1.56, .64, 1);  /* seating, stamps, chip state changes (existing overshoot) */
--sy-ease-draw:   cubic-bezier(.65, 0, .35, 1);     /* line / path draw (replaces 'easeInOut') */
--sy-dur-micro: 120ms; --sy-dur-ui: 200ms; --sy-dur-swap: 300ms; --sy-dur-reveal: 500ms;
--sy-dur-object: 900ms; --sy-dur-settle: 1400ms;
--sy-stagger: 40ms;  /* cap at 12 items (480 ms total) */
```

`ease-in-out`, `ease`, `linear` (except the existing 8 s dash loop) are banned on new work.

### 3.2 Reveal taxonomy (one idea per role; uniform fade-up is rejected)

| Role | Treatment | Implementation | When |
|---|---|---|---|
| R1 Prose | opacity 0 -> 1, 500 ms ease-settle, no translate | class toggle `is-in` by IntersectionObserver (`threshold .35`, once) | paragraphs, captions |
| R2 Rules/frames | path/stroke draw, 500 ms ease-draw, 40 ms stagger across lines | SVG `stroke-dasharray`/`pathLength` via class, no framer | FractureRule, NodeFrame, plate borders |
| R3 Figures | **stipple resolve**: shader `uResolve` 0 -> 1 over 900 ms ease-settle (dots fill in); DOM Still: opacity + 6 px scale 0.985 -> 1 | uniform tween / CSS | objects on first view |
| R4 Table rows | hairline draws first (240 ms), then cell text opacity (200 ms); stagger 20 ms, cap 24 rows, rows beyond the fold appear instantly | CSS classes | attack matrix, horizons, positions lists |
| R5 Integers | count-up (3.3) | | counts only |
| R6 Panels | height/opacity expand 300 ms ease-ui; never layout-shifting above the fold | `grid-template-rows: 0fr -> 1fr` | accordions, attempt result |

Banned: the same fade-up on every element; text parallax; scroll-jacking; wheel hijack; pinned sections that capture scroll (use `position: sticky` plus native scroll only); cursor-follow blobs; auto-playing sound; confetti on VALID.

### 3.3 Numbers

- Every number is a **prop** from `ClaimsNumber` / bundle / chain read. No literal digits in JSX copy except structural ordinals (card index, figure number) generated from array index.
- `CountUp` is allowed **only for integer counts** (attempts, trials, payments, businesses). Duration 700 ms ease-settle, start value = previous prop value (or the final value if first mount offscreen), end value **must equal the prop exactly**; a unit test asserts final text === `Intl.NumberFormat` of the prop.
- **Never count up money, a bound, a rate, a percentage or an upper limit.** A calculation does not "accumulate"; it is stated. Those fade in once (R1).
- `0` is shown as `0` immediately (no 0 -> 0 animation, no "loading zeros": a loading state is a hollow numeral, see 3.4).
- Money display always through `MoneyAmount`/`formatBaseUnits` (lane). The kit may convert to a **unitless ratio** for geometry only, via bigint basis points: `ratioBp = (value * 10000n) / total`, then `Number(ratioBp) / 10000`, quantized (below). Never `Number(bigint)` of an amount for text.

### 3.4 State grammar and transitions

Mode chips are **rectangular tags** (radius 2 px, mono uppercase 11/12 px, tracking .06em). Validity chips are **pills** (radius 24, Inter 13). Different shape, so a mode can never be mistaken for a validity.

| State | Chip skin | Contrast (text/ground) | Object treatment | Transition in |
|---|---|---|---|---|
| VALID | solid `#000` fill, white text, joined-halves glyph | 21:1 | token `seated`, solid | 300 ms: halves close with ease-snap |
| STALE | `#E2DDFC` fill, 1 px dashed `#232323` border, black text, offset-halves glyph | 16.0:1 | token `mismatch` (visible 2.5% gap + 2 deg), HorizonSteps lose stipple (contour + dashed), diff panel opens (R6) | 300 ms: halves part with ease-snap |
| UNVERIFIED | white fill, 1 px dashed `#6E6E6E`, `#6E6E6E` text, open-half glyph | 5.1:1 | token `hollow`; **no numeral is shown, ever** (outlined "Not computed", `-webkit-text-stroke:1px #6E6E6E`, transparent fill) | 200 ms opacity; no motion |
| RECORDED | white fill, 1 px solid `#000`, black text `RECORDED`, **plus** page inset 1 px dashed frame and frozen scenes | 21:1 | scenes render one frame and stop: no idle float, no pointer lean, no scroll assembly. **Motion encodes liveness: recorded things are still.** | none |
| SIMULATED | 1 px dashed `#232323`, hatch fill (`repeating-linear-gradient(135deg, #0000001A 0 1px, transparent 1px 6px)`), black text | 15.7:1 | hatch over the object/plate (shader `uHatch`) | 200 ms |
| LIVE | white fill, 1 px `#CCCCCC`, black text, 6 px periwinkle dot pulsing 2 s (existing `pulse`) | 21:1 text; dot 3.1:1 (non-text) | idle float enabled, data tick (R3) | 200 ms |
| LOSS / FAIL | solid `#B42318`, white text | 6.6:1 | lattice raised tile; row marker | 120 ms |
| DEMO | dashed `#6E6E6E`, text `DEMO` | 5.1:1 | hatch | |

Status is never colour-only: every chip has its word and a glyph. `aria-live="polite"` on any region whose state can change; transitions are suppressed (0 ms) under reduced motion but the state change itself is still announced.

Loading: no spinners, no shimmer. A loading plate is the object in `hollow` pose with a 1.2 s fracture pulse (the step edge brightens left-to-right, ease-draw). Reduced motion: static hollow plate + the word `Loading`.

### 3.5 Pointer and idle

- Lean: target angle = clamp(pointer offset) with a critically damped spring (stiffness 90, damping 19) -> 1.2 s settle. Return uses the existing `elastic.out(1.2, .4)` only on the home hero figure (Kevin's); new objects return with plain damping, no elastic.
- Idle: the existing `flying` timing (5 s, 5 px). One idle motion per scene.
- No pointer effects on touch; on touch the object eases through a 12 s autonomous 6-degree sway only while in view and only if motion is allowed.

### 3.6 Reduced motion, low power, no WebGL (authored, not just disabled)

| Condition | Detection | Result |
|---|---|---|
| `prefers-reduced-motion: reduce` | `matchMedia` + CSS `@media` | All scenes show a **keyframe pose chosen to preserve the story** (token: `seated` with the fracture still visible as a 2 px gap; lattice: final state; steps: final). Reveals are instant. Count-ups show final value. No parallax, no idle, no scroll linking. Path-draw lines render drawn. One frame is rendered, then the loop is stopped. |
| `Save-Data`, `deviceMemory <= 4` with `hardwareConcurrency <= 4`, or `prefers-reduced-data` | `navigator.connection.saveData` etc. | Stills only, no three chunk is requested. |
| Frame governor | rolling mean over 60 frames | > 28 ms: drop DPR to 1 and stop idle; second breach: swap to Still. |
| No WebGL2 / context lost / `webglcontextlost` | probe on mount | Still. Never an empty rectangle. |
| Offscreen / hidden tab | IntersectionObserver + `visibilitychange` | loop paused. |
| Challenge origin `/` | `NEXT_PUBLIC_PROFILE=challenge` (inlined, dead-code-eliminated) | No-3D variant; the three chunk is not emitted for that route. |

---

## 4. Hard constraints (non-negotiable)

### 4.1 Security, CSP, honesty

1. **No inline `style=` attribute and no SSR-emitted style**, including through framer-motion `motion.*` on server-rendered nodes. The CSP is `style-src 'self' 'nonce-...'` with no `unsafe-inline`. Dynamic values go through: (a) variant classes and `data-*` attributes (`data-state`, `data-ratio="0..20"` with `[data-ratio="7"]{--sy-r:.35}` generated in CSS), (b) client-only CSSOM writes in an effect (`el.style.setProperty`) — allowed because CSSOM is not an attribute in markup, (c) SVG presentation attributes. The kit's `Appear` replaces `Reveal`/framer opacity for new work.
2. No external fonts, CDN, scripts, analytics, remote images. Self-hosted assets from `/media`, `/fonts`, `/matcap.png`, `/tetrapod_v1.glb` only.
3. **No wasm on new pages**: no rapier, no `@react-three/rapier`, no draco/basis loaders. Pure three. Spring physics are hand-written. `three` and `gsap` and `framer-motion` are already dependencies; **no new dependency may be added** (any addition needs a `docs/CHANGELOG_SWARM.md` entry and SEC sign-off; assume refusal).
4. Banned words (lint walks `apps/web/src/**` including comments and `.tsx`): proven, provably, guaranteed (not preceded by no/not/never), audited (not "unaudited"), unhackable, unbreakable, 100% secure, risk-free. Do not write them in code comments either. Spine verbs allowed: bound, check, fit, recompute, verify, empirically tested, calculated from on-chain state.
5. **No hand-typed metric anywhere**, including alt text, aria-labels, captions, `<title>`, OG metadata and Storybook-ish demo data. Demo data in `DesignLab` carries `source: 'demo'` and a visible DEMO tag and its numbers are obviously non-claims (all zero / `—`). Planner/simulated figures labelled SIMULATED, bundle content RECORDED (and per `docs/QUESTIONS.md` 2026-10-12, nothing is called RECORDED unless a real model call produced it: use SIMULATED where the data says `recordedOutputs: false`; the kit maps `provenance.recordedOutputs === false` -> SIMULATED automatically).
6. **Untrusted text is inert.** The kit never touches attacker/invoice/LLM strings. Page bodies receive them only as `ReactNode` slots that the lane filled with `<UntrustedText>`. The kit never renders `dangerouslySetInnerHTML`, never auto-links, never uses untrusted strings in `href`, `id`, `className`, `data-*`, `aria-label` or keys.
7. No wallet code, no import from `apps/web/src/wallet/**`, `apps/web/src/challenge/**` or `apps/web/src/replay/**`; kit files may be imported by those lanes, not the reverse. No cookies, no storage (`localStorage` included), no network from the kit.
8. Route params are untrusted; page bodies never receive raw params, only validated view models.
9. Challenge origin: `/` renders the no-3D variant (HeroStill + stills). Other challenge-origin routes may use pure-three scenes **only if** `NEXT_PUBLIC_DESIGN_3D !== 'off'`; SEC can flip that flag with no redesign (see open question 3).

### 4.2 Performance budget (targets to *measure*, not to assert)

| Metric | Budget | Notes |
|---|---|---|
| LCP (mobile, throttled 4G, p75) | <= 2.5 s | LCP element is text or the Still, never a canvas |
| CLS | <= 0.05 | every canvas and Still has reserved aspect-ratio box |
| TBT | <= 200 ms | |
| INP | <= 200 ms | |
| JS per route excluding 3D chunk | <= 130 KB gz new route code | kit primitives are tree-shakable, no framer on SSR nodes |
| 3D chunk per route | <= 200 KB gz incl. `three`, loaded after idle + in view | `import { ... } from 'three'` named only; GLTFLoader only where the tetrapod is used |
| Canvases | **one per viewport**, max 2 per route; the footer canvas counts, so pages with a scene hide the footer scene behind its own IO | |
| DPR | `min(devicePixelRatio, 1.75)`; 1 on governor trip | existing hero uses 2; do not exceed |
| Textures | `matcap.png` is 560 KB and already paid by the footer; do not add textures. Stipple is procedural. | |
| Instancing | lattice uses one `InstancedMesh` (<= 2 draw calls with outline) | |
| Lighthouse | a11y >= 90 on every route, best-practices >= 90, perf >= 80 mobile on judge pages | |

All 3D is lazy: `next/dynamic(() => import(...), { ssr: false })` triggered by IntersectionObserver (`rootMargin: 200px`) and `requestIdleCallback`.

### 4.3 Accessibility

- Every canvas: `aria-hidden="true"`, `role="presentation"`, inside a `<figure>` whose `<figcaption class="sr-only">` states the **data-derived** meaning ("Attack lattice: Symbolon blocked 14 attacks, escalated 3, loss 1 ..." built from props, never hand-typed).
- Every interactive 3D affordance has a DOM twin (the lattice grid, the horizon table). Keyboard users never need the canvas.
- Focus: 2 px solid `#000` outline, 2 px offset, plus 4 px `#D5ABFF` halo; on black surfaces 2 px `#FFF`. The compiled CSS only has `focus:ring-gray-300` (fails); the kit supplies `.sy-focus` and a `:focus-visible` default inside `DesignRoot`.
- Touch targets >= 44 px; no hover-only information; `title` is not an accessible name.
- Tables use `<th scope>`, sticky first column, `<caption>`; the horizontal scroller is focusable (`tabindex=0`, `role=region`, `aria-label`).
- Contrast: see 5.3 computed table; friday re-verifies with a script in build step 1 and commits the output to the PR description.
- `lang`, landmarks (one `<main>`), heading order never skipped, visible skip link on pages with long matrices.

### 4.4 Hands-off surfaces (skin by tokens only; structure, order, labels, semantics fixed)

`UntrustedText`, `ApprovalScreen`, `RawTypedDataPanel`, `AdvisoryAI`, `ReceiptVerifier` (every PASS/FAIL/UNVERIFIED state), `StatusChip` semantics, `RecordedWatermark`/`RecordedBanner`, `ChecksTable` column order, `VerdictBadge`, `MoneyAmount`, `ClaimsNumber`, wallet gate, EIP-712 panels. What the kit may do: expose CSS custom properties they may read (`--sy-ink`, `--sy-plate`, ...) and class names the lane may *opt into*. What the kit must not do: wrap them in anything that clips, truncates, re-orders, hides on mobile, adds adjacent persuasion, or places decorative objects between a checks table and its verdict. Advisory (AI) prose is never adjacent to Approve; no decorative object between them either.

---

## 5. Page-by-page

Conventions: **Body** = presentational component in `components/pages/<name>/` taking a typed view model plus `slots`; the lane's page file does data fetching and passes in. Slot names are fixed here so the lane can pre-wire. Every Body wraps in `<DesignRoot mode profile>`.

Global page chrome (all new pages): `SiteShell` -> `main.relative.z-5` -> optional `ModeBar` slot (RECORDED/LIVE/health banner, lane-owned) -> sections. Header/Footer are the lane's.

### 5.1 Kevin-design pages (in depth)

#### `/` (home): the data blocks and the signature moment

Kevin keeps hero, gateway, market, native-currency copy. The kit supplies:

1. **`AssemblyBlock`** (wraps/augments "From invoice to receipt", `SectionOneClickDeployment`'s position). A 220 vh section with a sticky 100 vh stage. Scroll progress p in [0,1] (passive scroll listener -> rAF, no ScrollTrigger needed):
   - p 0 - .30 `approach`: proposal half enters from left, stipple resolves (R3); step 1 caption "The agent proposes" highlighted.
   - p .30 - .62 `scan`: chrome engagement half from right; a 1 px periwinkle scanline runs the fracture; check ticks light one by one (tick count = `checks.length` prop; if absent the scan is a continuous sweep and **no count is drawn**); caption "The kernel checks".
   - p .62 - .85 `seat`: halves seat with ease-snap 420 ms (only if `fit === 'match'`; else they stop 2.5% apart and the caption reads the template for non-release).
   - p .85 - 1 `seal`: ReceiptSeal stamps (ease-snap, 420 ms); caption "The vault releases". On `prefers-reduced-motion`: p fixed at 1, no scroll link.
   Data props: `fit: 'match'|'mismatch'|'unknown'` (default `unknown` -> hollow halves, nothing seats), `checks?: {id,status}[]`, `receiptHash?: Hex32` (seal ticks; absent -> hollow seal). **The decorative home token defaults to `unknown`, and a hollow seal, so it never asserts a fit nobody checked.** (Kevin may pass `match` only when the recorded run's decision is a RELEASE.)
2. **`AttackMatrixBlock`** (replaces `SectionPartnersLine`/`SectionPoweredBy`): eyebrow, heading "Twenty-four attacks, four targets" is **not** allowed (hand-typed); use "Every attack, against every baseline." Compact DOM lattice (10 px cells at mobile, 16 px desktop) + the four per-target totals as heading-h3 numerals with the target name, provenance tag, and one link `See the matrix ->` to `/attack-lab`. Props: `AttackMatrixSummary` (targets, cells, totals).
3. **`PilotStatsBlock`**: three numerals (businesses, real payments, value by network, never blended) + baseline line + `See the pilot ->`. Empty = honest zeros in hollow numerals + "Nothing has moved yet." Never a trend arrow.
4. **`SpineStrip`**: the four spine words as one typographic line each ("Don't trust the agent." / "Bound it." / "Prove it." / "Invite attack.") in `heading-h2`, each with its object (token, drum, seal, tetrapod) at 120 px, alternating left/right on desktop (asymmetric, not a 3-up grid). Reuses Kevin's hero icon set as nav pips.
5. **Challenge-origin `/`**: `HeroStill` (existing `figure-main-search` png centered + `footer-cta-bg` as the cloud + `HeroGridSvg` as is), no canvas, no `<video>`, no gsap lean, no FooterFigures.
Mobile: AssemblyBlock becomes a 3-step vertical sequence of Stills (no sticky stage), each step a `Plate`; matrix block becomes the 10 px DOM lattice.
States: data fetch failing -> blocks render RECORDED from bundle (lane slot); empty pilot -> hollow numerals.

#### `/judge`: "Check it without us in the room."

Concept: five cards, each a **two-half plate** (left = what was claimed, right = what the check says) meeting at the stepped fracture. Fit/non-fit is the grammar of the whole page.

```
[ModeBar: LIVE|RECORDED + reason]                                   (lane slot)
eyebrow  Guided review
H1  Check it without us in the room.   (FractureWord on "us")  | TallyToken 280px, hollow-> seats on load if mode=LIVE data ok
lede (body-text-l, gray-1000, max 440): one sentence
-- FractureRule --
 spine (desktop: x=64px dashed vertical with nodes; mobile: left edge)
 01 [ Plate: claim half | check half ]  Watch it get fooled and not lose money      [button-primary-s  Run / View the recorded run ->]
 02 [ ReceiptSeal 32 ticks ]            Verify a receipt yourself                    [ Verify /audit/<hash> ->]
 03 [ HorizonSteps + mini what-if slot ] Recompute the loss bound                    [ copy: pnpm lbc verify <vault> ]
 04 [ TetrapodWall + scoreboard slot ]   Try to break it   (cross-origin link slot)
 05 [ pilot rail ]                       See the real users  -> /pilot
-- FractureRule --
 "What this does not do"  card-black, full width, heading-h2 white, 5 rows as positions__item (black variant) + small-tag each
-- footer CTA --
```
- Cards **alternate** plate side and width (7/5 then 5/7 columns at `lg`); no symmetric 3-up anywhere.
- Card 1 is the page's emotional peak: left half (periwinkle) shows the extractor's claim as an `UntrustedText` slot; right half (chrome) shows kernel verdict `REJECT` + K-ids from slots; **halves are drawn 2.5% apart and do not close** (mismatch). Below: "B1 / B0 outcome" as two hairline rows with loss in `#B42318` only if the data says loss, and the line "Vault would revert" from data.
- Card 2 shows the seal for the **fixture** receipt with a DEMO/FIXTURE tag until a real receipt exists (plan Missing/Wrong list); copy never says "real" in that state.
- Card 3 shows exclusions line first (small, but present), status chip slot, headline from slot; the HorizonSteps is decoration beside it.
- "What this does not do" is designed as a premium moment (black card, hover figure scale), not fine print. It lists work quality, owner-key compromise, availability, unaudited code, simulated planner results (copy is static and lives in the Body).
- Empty/loading: plates in hollow pose, fracture pulse. Replay: ModeBar slot + dashed frame + frozen scenes + RECORDED tag on each card header. Error: card-level `FailClosedNotice` slot, token stays hollow.
- Mobile 360: spine to left edge; each plate stacks (claim above, check below, fracture horizontal); buttons full width, 44 px; "does not do" card first-class; no canvases (Stills only).
- Slots: `modeBar`, `card1.claim`, `card1.verdict`, `card2.receiptLink`, `card3.statusChip`, `card3.headline`, `card3.whatIf`, `card4.scoreboard`, `card4.crossOriginLink`, `card5.pilotSummary`.
- Screenshot moment: card 1's two halves that will not close.

#### `/attack-lab`: "Every attack. Every baseline."

Concept: the matrix **is** the hero; the lattice is its relief map.
```
eyebrow Attack lab · [Mode tag] · provenance tag (mode: unit / harness / oracle version from data)
H1 Every attack. Every baseline.
[ AttackLattice canvas band 340px desktop | AttackLatticeGrid DOM on mobile ]   legend (cell grammar)
Totals strip: 4 columns Symbolon | B0 | B1 | B2   (equal weight; Symbolon column ink-solid border, others dashed; not-built columns hatched with "Not built yet")
   per column: "loses on k of n applicable"  (k, n from data), trials, upper bound text as provided, scoring split oracle vs signal
-- FractureRule --
Matrix table: rows ATK-01.. (24), columns Attack | Symbolon | B0 | B1 | B2 ; each cell = glyph + word + loss (MoneyAmount slot) ; row expands (R6) to: checks fired, vault revert, payload (UntrustedText slot), applicability reason
-- FractureRule --
Hold-out: root hash (mono, middle-truncated, full via copy), n, k, upper bound "(~3/n when k = 0)" as provided
Honest corpus: n, released, wrongful rejects (Wilson bound as provided) - hollow if absent
Reproducibility: gitSha (null renders "unrecorded"), seed, models line, harness, oracle, "no model was called" -> SIMULATED tag
Known limits: positions list from results.limitations[]
```
- Column-lock: focus/hover a table row -> lattice column lights; hover lattice column -> table row scrolls into view (`scrollIntoView({block:'nearest'})`, instant under reduced motion).
- N/A rows stay in the table with reason, excluded from denominators, text says so.
- Symbolon's own loss cell is rendered at full strength, and the totals strip states it in words. Never hide it behind a legend.
- Mobile: DOM lattice 10 px cells (24 x 4 = about 290 px wide), then table with sticky first column, horizontal scroll region; per-column totals become a 2 x 2.
- Loading: hollow lattice (96 sockets) + fracture pulse. Replay: frozen + RECORDED/SIMULATED per provenance.
- Screenshot moment: the lattice with one tall loss-red tile and black caps everywhere else, labelled.

#### `/certificate/[vault]`: "A bound you can recompute."

Order is fixed by spec (do not move): **exclusions -> generated headline -> status chip -> horizon table -> alarmed variant -> assumptions -> validation -> verify command -> STALE diff.**
```
eyebrow  Loss bound certificate   · vault short id (mono, UntrustedText slot not required: validated address)
-- Exclusions: card-black, full width, heading-h5 rows X-OWNER-KEY ... (above the number; never below, never collapsed)
-- Plate: [ headline (slot: generated sentence + numeral) | status chip slot | asOf block+hash | certHash ] with TallyToken state icon + VaultDrum(small)
      numeral size heading-hero; UNVERIFIED -> outlined "Not computed"
-- Horizon table (lane `HorizonTable` slot or Body-owned view) + HorizonSteps beside (desktop) / above (mobile, still)
-- Alarmed variant: dashed ghost slab + row labelled "If the monitor and guardian work (assumes A-MON)"; never styled as headline
-- Assumptions: positions list with ids A-EVID.. (text from cert)
-- Validation: trials, violations, upper95 as provided, tightness; codeMatch wording per docs/16; null -> "Not validated for this deployment" hollow block
-- Verify: CopyCommand (mono, black card), exit-code legend (0 VALID, 10 STALE, 30 MISMATCH)
-- STALE diff: only when status STALE: two-column before/after (halves metaphor), reasons list
```
- Statuses: VALID/STALE/UNVERIFIED per 3.4; also MISMATCH (codeMatch) = loss-red tag on the validation block only; RPC down -> UNVERIFIED, numeral outlined, bound table rows read "Not computed".
- Hero object: TallyToken `seated` (VALID) / `mismatch` (STALE) / `hollow` (UNVERIFIED), 160 px beside the plate; HorizonSteps 360 px.
- OG/metadata: no numeral anywhere.
- Mobile: single column; exclusions first; numeral wraps at heading-h1; horizon table scroll region; steps become Still above the table; verify command wraps with copy button >= 44 px.
- Screenshot moment: the black exclusions slab sitting above a hairline numeral.

#### `/challenge`: "Make it pay the wrong person."

```
ModeBar slot (LIVE|RECORDED; degrade ladder banner L1/L2)
H1 Make it pay the wrong person.       | TetrapodWall + wave canvas (desktop 420px; Still on mobile)
Rule sentence (body-text-l): "A loss is money reaching the wrong place, in the wrong amount, or twice."
Scoreboard (3 stats, each with a LIVE/RECORDED tag):
   distinct human attempts N | loss events L | upper bound  (text from `ChallengeStats` via slots)
   N = 0  -> N shows 0, bound numeral hollow "—", line "No independent attempts yet."
   L > 0  -> shows L and byPredicate chips (O1..O8), NO 3/N line, link slot "incident note"
   oracle disagreement -> visible tag
-- Card A One-click: 24 tiles (grid 4 cols lg / 2 cols mobile, 44 px min height; tile = mismatched-halves glyph + ATK id (mono) + plain-English caption)
-- Card B Benign controls: 6 tiles with **matched-halves glyph** (they should pay) + "would broadcast" slot
-- Card C Write your own: plate with textarea (max bytes from prop), byte counter, scenario segmented control (S-A/S-B/S-C as existing `tab-wrapper-m`), CAPTCHA slot; submit button-primary-m
-- Output panel: SAFETY slot (AttemptResultPanel) pinned right (>= lg, sticky) / inline directly under the active tile (mobile); `aria-live="polite"`
-- Card D Certificate: mini certificate plate (chip slot + link)
-- Prove on-chain: states idle / rate-limited / daily cap exhausted / success (explorer link slot); all labelled TESTNET
-- Cross-origin CTA row: Lite check -> app origin; "Pilot this on one real invoice"; NOT traction
-- TrafficDisclaimerFooter slot (fixed text "Attack traffic is not customer traffic") + /security link + "Synthetic data only"
```
- 3D: wave rises on each result event (event prop `resultTick`), tetrapods lean. No wallet imports; no cookies; Stills when `profile==='challenge' && 3D off`.
- Visual grammar: attack tile = periwinkle half that does **not** fit; benign tile = fits. At a glance the grid reads "things that should be refused" vs "things that should pay".
- Loading, replay (L2: all tiles disabled? No: tiles remain, results come from the bundle, RECORDED tag per result), L3 (static scoreboard + cert image).
- Mobile 360: scoreboard stacks, grid 2-col, output panel inline, sticky bottom none (no fixed bars).
- Screenshot moment: the tetrapod wall with the periwinkle wave breaking on it behind a scoreboard of zeros that are honestly labelled.

#### `/pilot`: "What actually moved."

```
H1 What actually moved.
Honest-empty plate: TallyToken in `hollow` pose (halves apart, contour only) + caption "At Tameion start: spec only, 0 users, 0 USDC" (baseline numerals from `baseline` prop)
Two network plates, side by side on lg, stacked on mobile: Testnet | Mainnet  (never one combined figure; no sum element exists in the API)
   each: businesses, real payments, value (MoneyAmount slot), distinct payees; empty -> hollow numerals
Payments rail: a horizontal dashed timeline, one node per real payment, each node = ExplorerLink slot; none -> single baseline node
"Not counted": card-black, rows: challenge attempts, house attackers, demo tenants, "internal" (each tagged EXCLUDED)
Late events: tag "as of <freeze stamp>" + "late" label on post-freeze rows
Consent slot: names/quotes only if present
```
- The token turns from hollow to solid only when `payments.length >= 1` (a binary state, never a fill ratio). No progress bars, no target props accepted by any component (type-level absent).
- Screenshot moment: the hollow token with its honest baseline.
- Mobile: plates stack; rail scrolls horizontally with snap; explorer links >= 44 px.

#### `/security`: "Attack us, in good faith."

Typography only. Long-form prose from `StaticMarkdownPage` (lane) styled by `.sy-prose`: measure 62 ch, `heading-hero` h1, `heading-h3` section heads with dashed-hairline anchors and node markers, `body-text-m`, lists with a 6 px periwinkle square marker, code/pre in mono on `#F4F4F4` with a 1 px dashed `#6E6E6E` border (quarantine plate). A sticky left rail ToC (desktop) with node marker for the current section (IntersectionObserver). "What we claim / what we do not claim" as two columns separated by a FractureRule (rotated). Contact block = card-black. No 3D, no motion beyond R1/R2. Mobile: ToC collapses into a `<details>` at the top.
- Wording rule: the page can never say "cannot be broken"; the kit never inserts copy on this page.

### 5.2 Lane and safety pages: token-level skinning and what must not move

The lane builds structure first. The kit ships `styles/lane-skin.css` keyed on `data-sy-role` attributes the lane adds (one attribute per component, list in 6.2). Nothing else.

| Route | Skin | Allowed object | Must not move / change |
|---|---|---|---|
| `/audit` | `.sy-prose`, input plate (dashed 1 px `#6E6E6E` border, mono), example hashes as `small-tag` | ReceiptSeal Still, **hollow only** | invalid input rejected inline; no routing on bad input |
| `/audit/[receiptHash]` | step list as nodes on a dashed rail; PASS = solid ink node, FAIL = `#B42318` node + word, UNVERIFIED = hollow dashed node | ReceiptSeal driven by the verifier's computed result via required `status` prop, **no default**; unknown -> hollow; flipped byte -> one tick differs | every state, step order, "NOT VERIFIED" wording, the raw values; seal must never look "complete" unless every step is PASS |
| `/replay/[bundle]` | frozen scenes, dashed page frame, `.sy-prose` | any Still | RECORDED watermark/banner structure; hash-mismatch state |
| `/blast-radius` | headline card (`card-light`), threat table (hairline rows, mono ids), assumptions panel always visible | TetrapodWall (3D on app origin), VaultDrum | assumptions/limits visibility; sliders never styled like a certificate (SIMULATED hatch plate) |
| `/blast-radius/audit` | form plate, `button-primary-m` | none | consent flag |
| `/docs` | `.sy-prose` + left nav | none | |
| `/dashboard` | `card-light` KPI plates, decisions feed as `positions`; breaker HALTED = black plate + hollow drum | VaultDrum (ring = real cap ratios), small | fail-closed states: kernel unreachable never rendered as stale-as-live; `MoneyAmount` only; unfreeze dialog |
| `/engagements/new` | form plates, signature stepper nodes on dashed rail | TallyToken Still (apart) | terms preview, typedData hash, bigint amounts, `UntrustedText` for free text |
| `/engagements/[id]` | state icon: DRAFT hollow apart / AWAITING_PAYEE one half solid / REGISTERING seated + dashed seam / ACTIVE seated solid / CLOSED seated + seal / CANCELLED apart dashed | TallyToken Still 56 px, `aria-hidden`, adjacent text status mandatory | ACTIVE only after indexer sees the event; stepper semantics |
| `/sign/[token]` | single 560 px column, no 3D, large network label tag | none (token Still 40 px max) | rendered model byte-equal to signed model; raw typedData beside wallet prompt; link token is not authority |
| `/intents/new` | dropzone = dashed `#6E6E6E` plate | none | caps, text-only extraction path, "nothing was paid" copy |
| `/intents/[id]` | checks table first; verdict as large fit/non-fit Still **above** the table heading, never between the AI prose and Approve | TallyToken Still (match/mismatch) | order: checks -> agent vs kernel -> templated explanation -> plan -> approval; Advisory (AI) collapsed; no bulk approve; Approve disabled states |
| `/intents` | `positions` rows, ranked digest | none | no bulk-approve |
| 404 | "The halves do not fit." two mismatched halves Still, link home | TallyTokenStill (mismatch) | validated-param 404: never echo the param |
| error | "The token is broken." hollow halves; error id only | TallyTokenStill (hollow) | no stack traces, no echo |

### 5.3 Contrast table (hand-computed; friday re-verifies by script)

| Pair | Ratio | Use |
|---|---|---|
| `#000` on `#FFF` | 21.0 | body, VALID, RECORDED |
| `#232323` on `#FFF` | 15.7 | buttons, SIMULATED/dashed ink |
| `#6E6E6E` on `#FFF` | 5.1 | muted body, UNVERIFIED chip, semantic dashes |
| `#6E6E6E` on `#F4F4F4` | 4.6 | muted text on tray/plate (passes AA, thin margin: no text smaller than 13 px) |
| `#878787` on `#FFF` | 3.6 | large text / UI only (not body) |
| `#5B47E6` on `#FFF` | 6.0 | **new**: periwinkle-as-text (links in prose, eyebrows). Darkened `#9280FC`; `#9280FC` itself is 3.1 and must not be used for text under 24 px |
| `#9280FC` on `#FFF` | 3.1 | objects, lines, dots (non-text >= 3) |
| `#000` on `#E2DDFC` | 16.0 | STALE chip |
| `#000` on `#D5ABFF` | 11.1 | cta button |
| `#FFF` on `#000` | 21.0 | black cards |
| `#939393` on `#000` | 6.8 | card-black secondary text |
| `#B42318` on `#FFF` | 6.6 | **new, the only added status colour**: LOSS/FAIL |
| `#FFF` on `#B42318` | 6.6 | loss chip |
| `#CCCCCC` on `#FFF` | 1.6 | decorative grid only (exempt as decoration) |

---

## 6. File layout (friday may create only these)

```
apps/web/src/styles/
  design.css            :root --sy-* tokens (3.1, colours, radii), .sy-focus, .sy-prose, .sy-chip--*, .sy-tag--*, hatch, data-ratio buckets 0..20
  design-motion.css     reveal classes, FractureRule/NodeFrame draw, reduced-motion overrides
  lane-skin.css         [data-sy-role="..."] skins for lane/safety pages (5.2)
apps/web/src/components/design/
  index.ts                         barrel
  DesignRoot.tsx                   imports the 3 css files; sets data-sy-mode/profile; capability context
  runtime/  useDesignCapabilities.ts  useInView.ts  useReducedMotion.ts  useFrameGovernor.ts
            useThreeScene.ts  spring.ts  quantize.ts (ratioBp -> bucket 0..20)  ratio.ts (bigint -> bp)  format.ts (integer count formatting)
  primitives/ Appear.tsx  CountUp.tsx  FractureRule.tsx  NodeFrame.tsx  FractureWord.tsx
              Plate.tsx  Eyebrow.tsx  SectionHead.tsx  PositionsList.tsx  Tag.tsx (mode tag skin only)
              Stat.tsx  CopyCommandSkin.tsx (class helpers only, no behavior)
  three/      InkStippleMaterial.ts  InkOutline.ts  ChromeMaterial.ts  fracture.ts (step polyline + Shape builder)
              TokenGeometry.ts  DrumGeometry.ts  SealGeometry.ts  LatticeInstances.ts  StepsGeometry.ts  TetrapodLoader.ts
              SceneHost.tsx (canvas host: lazy, IO, governor, context-loss -> Still)
  objects/    TallyToken.tsx  VaultDrum.tsx  ReceiptSeal.tsx  AttackLattice.tsx  HorizonSteps.tsx  TetrapodWall.tsx  AttackWave.tsx
  stills/     TallyTokenStill.tsx  VaultDrumStill.tsx  ReceiptSealStill.tsx  AttackLatticeGrid.tsx
              HorizonStepsStill.tsx  TetrapodStill.tsx  FooterTetrapodsStill.tsx  HeroStill.tsx
  dev/        DesignLab.tsx   (all objects x all states; demo data tagged DEMO; mounted by the lane under a dev-only route, see 7)
apps/web/src/components/pages/
  home-blocks/  AssemblyBlock  AttackMatrixBlock  PilotStatsBlock  SpineStrip   (+ types.ts)
  judge/        JudgeBody  JudgeCard  DoesNotDoCard  (+ types.ts)
  attack-lab/   AttackLabBody  TotalsStrip  MatrixTable  HoldoutBlock  ReproBlock  (+ types.ts)
  certificate/  CertificateBody  ExclusionsSlab  HeadlinePlate  VerifyBlock  StaleDiff  (+ types.ts)
  challenge/    ChallengeBody  ScoreboardPlate  AttackTileGrid  BenignGrid  WriteYourOwnPlate  ProveOnchainBlock  (+ types.ts)
  pilot/        PilotBody  NetworkPlate  PaymentsRail  NotCountedCard  (+ types.ts)
  security/     SecurityBody  TocRail  ClaimColumns  (+ types.ts)
```
Rules: never edit `apps/web/src/app/**`, `src/lib/**` (importing `lib/waveShaders` read-only is allowed), middleware, `src/wallet/**`, `src/challenge/**`, `src/replay/**`, any safety component, API routes, `package.json`, `next.config.mjs`. Page Bodies do **no data fetching**, no `fetch`, no `useEffect` network, no wallet imports; they take typed props and ReactNode slots. Slot components are never imported by the kit (the lane passes them). Colocated `*.test.ts` for pure helpers (`fracture`, `quantize`, `ratio`, `format`, state -> pose maps) so the root vitest picks them up; do not touch `package.json`.

### 6.1 View-model contract (page bodies; lane maps data -> these)

Bodies depend on `@symbolon/schemas` **types only** (`import type`), derived from `LossBoundCertificate`, `ChallengeStats`, `attack-matrix/1`. No runtime import of schemas in the kit. Money fields stay `string` base units + `tokenDecimals`; the Body never parses them; display goes through a `renderMoney(amount, decimals): ReactNode` slot supplied by the lane (`MoneyAmount`). Mode type: `'live'|'recorded'|'simulated'|'demo'`.

### 6.2 `data-sy-role` vocabulary the lane should add (for `lane-skin.css`)

`checks-table`, `check-row`, `verdict`, `receipt-step`, `typed-data`, `approval-area`, `advisory`, `untrusted`, `kpi`, `feed-row`, `stepper`, `stepper-node`, `form-plate`, `dropzone`, `network-tag`, `explorer-link`, `breaker`. These attributes carry no behaviour; they only select skins.

---

## 7. Build order with acceptance criteria

**Principle: DOM first, canvas last.** Everything through step 12 ships with Stills only. If time dies at step 13 the site is complete and correct. Clock: designs due Thu 12:00 IST; work through the list in order, commit after each numbered step (`feat(web-design): ...`).

| # | Build | Acceptance (checkable) |
|---|---|---|
| 1 | `styles/design.css`, `design-motion.css`, `DesignRoot`, contrast script output in PR | all `--sy-*` tokens from 3.1 + 5.3 present; `grep` shows no value outside this brief; `.sy-focus` visible on white and black; every pair in 5.3 re-computed by script and pasted in the PR; `claims:lint` clean |
| 2 | `runtime/*` (`useDesignCapabilities`, `useReducedMotion`, `useInView`, `quantize`, `ratio`, `format`, `spring`) | unit tests: `ratio(1n,3n)` -> 3333 bp, `quantize` 0..20 monotone, `format` of integers; capabilities returns `stills-only` when saveData/reduced-motion/no-WebGL/challenge+`3D off` |
| 3 | `primitives/*` (Appear, FractureRule, NodeFrame, FractureWord, Plate, SectionHead, PositionsList, Tag, Stat, CountUp) | zero `style=` in rendered HTML (curl SSR output, grep); Appear renders content at opacity 1 with JS disabled; CountUp final text === formatted prop, never animates a non-integer; reduced motion -> instant; FractureWord readable text node intact (copy-paste returns the word once) |
| 4 | `stills/*` (all eight) | each Still: inline SVG/CSS only, `role="img"` with data-derived `aria-label` or `aria-hidden` + adjacent text, fixed aspect box (CLS 0), renders identical without JS; `AttackLatticeGrid` is a real DOM grid with per-cell word label, keyboard focusable, row/column headers |
| 5 | `DesignLab` (dev) | every object x every state (3.4) x mobile/desktop in one page; demo data shows DEMO tag; no number outside DEMO |
| 6 | `pages/judge/*` | five slots wired; card 1 halves do not seat; "does not do" is a card-black block; at 360 px no horizontal scroll; Lighthouse a11y >= 90; works with mode=recorded |
| 7 | `pages/attack-lab/*` | renders the real `results/attack-matrix.json` shape incl. not-built targets and Symbolon's loss cell; N/A rows present with reasons; sticky first column; column-lock works by keyboard (focus row -> column highlight) |
| 8 | `pages/certificate/*` | DOM order exactly 5.1 list (assert via test on rendered order); UNVERIFIED shows no digits in the numeral region; STALE shows diff; exclusions above numeral in source order and visually |
| 9 | `pages/challenge/*` | scoreboard states N=0 / L>0 / normal all render from props; tiles >= 44 px; no import from `src/wallet`; output panel is a slot only |
| 10 | `pages/pilot/*` | zero payments -> hollow token + hollow numerals + baseline; testnet and mainnet plates separate; no component accepts `target` |
| 11 | `pages/security/*` + `.sy-prose` | 62 ch measure; ToC rail; keyboard anchors; no 3D |
| 12 | `pages/home-blocks/*` (Stills + DOM lattice + AssemblyBlock in **reduced/seated** mode) | blocks work in RECORDED; no hard-typed digit; `HeroStill` has no canvas/video/gsap; AssemblyBlock default fit is `unknown` |
| 13 | `three/*` + `objects/*` + `SceneHost`: InkStipple, outline, chrome, TallyToken first | side-by-side screenshot with `figure-main-*.png`: same periwinkle, contour and stipple direction (reviewer judgement; attach both); governor trips to Still under 4x CPU throttle; context-loss shows Still; no console errors; loop stops offscreen; 3D chunk <= 200 KB gz (bundle analyzer output attached) |
| 14 | AttackLattice, HorizonSteps (instanced, ratios via bp) | one `InstancedMesh`; hovering a table row lights its column; heights match `value/balance` within one bucket (test); no number rendered inside canvas |
| 15 | TetrapodWall + AttackWave (reuse `waveShaders`) | no rapier import (`grep -r rapier components/design components/pages` empty); matcap on black only; wave reacts to `resultTick`; `FooterTetrapodsStill` provided |
| 16 | Home `AssemblyBlock` scroll-linked mode | reduced motion shows seated pose; scroll linkage uses passive listener + rAF; no pinned wheel capture; mid-scroll screenshot at p=.5 attached |
| 17 | `lane-skin.css` + skin notes against the roles in 6.2 | applying it to a page with none of the attributes changes nothing (no global element selectors); hands-off components' computed structure unchanged (diff of DOM order) |
| 18 | Final pass: Lighthouse on all seven Kevin pages (mobile+desktop), `claims:lint`, grep checks (no `style=`, no banned words, no `dangerouslySetInnerHTML`, no wallet imports, no external URLs) | results pasted in PR; every failure listed with owner |

Review gate (jarvis): a page is ELITE only if it has its signature moment, uses custom easing everywhere, has no uniform fade-up, passes the honesty greps and renders correctly with canvases disabled. Well-executed generic is still rejected.

### 7.1 Hand-offs friday cannot do (for the web lane / ORCH, not for friday)

1. A dev-only route file (one line importing `DesignLab`) under `app/**`.
2. Replace `Reveal` usages and the 18 `style=` attributes (R6), wire `FooterTetrapodsStill` for the challenge profile (R5), add `data-sy-role` attributes (6.2), import nothing else.
3. Header/Footer IA per `WEB_PAGES_PLAN.md` section 6 (R3, R4, R7).
4. Remove R1 logos and adopt `AttackMatrixBlock` / `PilotStatsBlock` (Kevin's call, see question 2).

---

## 8. Banned moves for this build (beyond the standing list)

Purple-to-pink gradient hero on dark; glass or blur cards; glow, bloom, lens flare; particle or star fields; orbiting rings; "AI brain" or neural-net imagery; padlock/shield/checkmark-badge icons for security; green success states and checkmark confetti; donut/pie/bar charts of loss data; 3D bar charts; skeuomorphic vault doors; looping hero video on judge pages; count-up on any money, bound or rate; a counter that moves while a RECORDED tag is shown; decorative object between a checks table and its verdict; progress bars toward pilot targets; any element that is both decorative and a status (a decorative token must not carry a state a reader could take as the product's verdict; it is `unknown`/hollow by default); mock testimonials, partner strips, trust badges; icon-in-circle feature rows; symmetric 3-up card rows on any new page.

---

## 9. Open questions for Kevin (only these)

1. **One new colour.** Allow `#B42318` as the only added status colour (LOSS/FAIL cells and chips; 6.6:1 on white)? Without it a loss cannot be told apart from a block by anything other than shape, and Symbolon's own results currently contain one oracle-scored loss that must be impossible to miss. Default if no answer: yes.
2. **Template illustration and logo strip.** May the kit's `AttackMatrixBlock` and `PilotStatsBlock` replace `SectionPartnersLine`, `SectionPoweredBy`, `SectionAgentFrameworks` (all third-party logos) and `about/SectionPartners`, and may `AssemblyBlock` take over the "From invoice to receipt" slot, with the raster figures (including the one that has "AI AGENT 694" baked in) retired from `/`? These are your pages; I did not assume.
3. **3D on the challenge origin.** You asked for a no-3D `/` on the challenge origin. Pure three needs no wasm, so I allowed scenes on `/challenge`, `/attack-lab`, `/certificate` behind a build flag `NEXT_PUBLIC_DESIGN_3D`. Confirm, or force Stills on the whole challenge origin (a one-line flip, no redesign).
4. **"Built on Arc" and Circle.** Keep the existing `Built on Arc` label with `arc-logo-transparent.png` (factual platform attribution, already in the hero) and allow the word "Circle" in text only, or treat both as third-party marks to remove?
5. **Material semantics.** I made periwinkle stipple mean "agent/untrusted/advisory" and black chrome mean "signed/kernel/on-chain", which brings chrome onto white pages for the first time (today it exists only in the footer). Shout if you want chrome kept to the footer; the fallback is the black half rendered as flat ink with the same contour.
