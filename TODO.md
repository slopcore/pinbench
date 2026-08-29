# Gap report — Claude Design mock vs. delivered app

Source of truth for the design: **"ESP simulator UI design"** in Claude Design
(`PinBench.dc.html`, project `338c3d78`). Compared against the renderer on branch
`usb-flash` (`src/renderer/src/**`).

## Framing

The design is an **M9‑specific mock with fabricated data**: seven canned source
files, a scripted boot log, a hard‑coded "31 GPIO assigned", ½/¾/1:1 screen
buttons, a BL toggle. The delivered app is **board‑agnostic and data‑driven** off
`boards/*.board.json`. So several "differences" are correct generalizations, not
gaps:

- Library grouped by part category (design hard‑codes "On board · M9 V1.0")
- Status‑bar totals computed from the board definition (design overlays a canvas chip)
- A live PlatformIO file tree (design lists seven fixed files)
- Board picker in the status bar (design has a top‑bar chip)

**Data is already at parity.** Board JSON `u1…u9` map 1:1 onto the design's nine
nodes; both have 12 nets. Every gap below is presentation or interaction, never
missing board data.

Tags: `[tracked]` = already on `docs/status.md` "Next"; `[untracked]` = surfaced
only here.

---

## A. Missing — in the design, not built

### Canvas

- [ ] **Rich node cards with a CFG / IN / OUT tab strip.** Design node = an HTML
      card: header (glyph, title, class badge), a `CFG|IN|OUT` segmented strip,
      and a body that switches between pin rows, stimuli, and a log/screen.
      Delivered node = a plain SVG `<rect>` with designator, name, "N pins".
      `[untracked]` (distinct from "canvas editing") — `components/Canvas.tsx`
- [ ] **Net labels on the canvas.** Design draws pill‑boxed midpoint labels
      (`SPI0 · NSS39`, `IRQ/BUSY`, `UART1`, `I2C0`, …). Delivered nets are bare
      polylines, no labels. `[untracked]` — `components/Canvas.tsx`,
      `components/canvas.css`
- [ ] **Dismissible "Shared SPI bus" toast** (top‑right of the canvas). The
      SPI‑contention *diagnostic* ships in the Dock; the canvas toast does not.
      `[untracked]` — `components/Canvas.tsx`
- [ ] **Canvas stats overlay chip** ("9 parts · 12 nets · 31 GPIO assigned",
      bottom‑left). Delivered shows totals only in the status bar. `[untracked]`
      / partly `[tracked]` as a relocation — `components/Canvas.tsx`
- [ ] **Bus‑labels visibility toggle** (design: View ▸ "Bus labels", key `L`),
      gates the net labels above. `[untracked]` — `shared/commands.ts`,
      `state/useWorkspace.ts`
- [ ] Canvas editing: drag parts, Draw‑net tool, Probe‑pin tool, `⌘Z`, persist
      edits, wire the generated header into the build. `[tracked]` (status.md
      "Next"; `net`/`probe` tools ship disabled in `Toolbar.tsx`)

### Inspector

- [ ] **Identity section** — Reference / Class / Position rows. `[untracked]` —
      `components/Inspector.tsx`
- [ ] **Nets (N) section** — one row per connected net, value coloured by bus
      kind. `[untracked]` — `components/Inspector.tsx`
- [ ] **Firmware hook card + "Reveal in source" button** — per‑part hook symbol
      (`Lr1110::begin()`, `HomePage::draw()`, …) with a note and a jump‑to‑source
      action. `[untracked]` — `components/Inspector.tsx`, `state/useProject.ts`
- [ ] Per‑part IN panel is LR1110‑only (`InPanel.tsx` early‑returns for every
      other model). Design gives every part stimuli (resets/boot straps for the
      MCU, card insert/remove for SD, NMEA scenarios for GNSS, RTC/IMU/mag for
      the sensor cluster, battery/charger/buzzer for power, console replay for
      USB, full key matrix for the keyboard). `[tracked]` (device models +
      general Inspector‑config mechanism on status.md "Next")
- [ ] Keyboard IN panel: QWERTY matrix + D‑pad + HOME/BACK/MENU/CHAT/MAP/LOC
      shortcut keys + a key buffer readout. Nothing rendered today. `[tracked]`
- [ ] LCD OUT panel: ½ / ¾ / 1:1 zoom buttons and a `BL ON/OFF` toggle on the
      panel itself. **Relocated**, see section B — not a true gap.

### Toolbar & menus

- [ ] **Bus filter chips** (SPI / I2C / UART / GPIO toggles) in the toolbar's
      second row — dim/hide nets of a bus. No equivalent anywhere in the repo.
      `[untracked]` — `components/Toolbar.tsx`, `components/Canvas.tsx`,
      `state/useWorkspace.ts`
- [ ] **Top‑bar "Verify" button** and **port label** (`/dev/cu.usbserial-M9`).
      Verify exists only as Build ▸ Verify pin map; there is no always‑visible
      button and no port readout. `[untracked]` — `components/Toolbar.tsx` /
      `components/StatusBar.tsx`
- [ ] **File ▸ Export board_m9.h.** `generatePinHeader()` /
      `generateBuildFlags()` exist (`shared/codegen.ts`) but are reachable only
      through the ACP invoker — no menu item, no button. `[untracked]` —
      `shared/commands.ts`, `src/main/menu.ts`, `App.tsx`
- [ ] **Edit menu semantics.** Design: Undo move / Duplicate part / Delete part /
      Auto‑arrange by bus. Delivered: generic Undo/Redo/Cut/Copy/Paste/Select‑all,
      all `enabled: false`. `[tracked]` (canvas editing) — `shared/commands.ts`
- [ ] **Dead Help items.** `help.shortcuts` and `help.about` fall through to
      `break` in `runCommand` (`App.tsx`) — menu entries with no handler.
      `[untracked]`
- [ ] File ▸ "Import M9 pinout" and Help ▸ wiki / user‑guide links have no
      delivered equivalent. `[untracked]` (low priority) — `shared/commands.ts`

### Library

- [ ] **"Expansion · generic" group** (LED, button, NeoPixel, DHT22, servo) and
      **"Firmware modules" group** (MeshCore stack, Home page UI, Storage/FS).
      Delivered lists only the board's own parts. `[tracked]` (generic expansion
      parts on status.md "Next") — `components/LibraryPanel.tsx`
- [ ] **`＋` place affordance** on each row and the footer hint ("Click a part to
      place it, then drag on the canvas to arrange"). Delivered rows only select.
      `[untracked]` (pairs with canvas editing) — `components/LibraryPanel.tsx`

### Dock

- [ ] **Dock meta line** (`115200 8N1 · CH340K` on Serial, `N messages` on
      Diagnostics) in the tab strip. `[untracked]` — `components/Dock.tsx`
- [ ] **Collapse chevron.** Design collapses the dock to a 30px strip via a
      chevron; delivered has an `×` that hides it entirely (reopened from the
      toolbar/menu). Minor behaviour difference. `[untracked]` —
      `components/Dock.tsx`

---

## B. Relocated — built, different home (confirm these are deliberate)

| Design location | Delivered location |
| --- | --- |
| IN / OUT tabs inside the canvas node | Inspector sections (`InPanel` / `OutPanel`) |
| Board chip in the top bar | Status‑bar `<select>` picker (`StatusBar.tsx`) |
| Canvas overlay: parts · nets · GPIO totals | Status bar totals (`boardTotals`) |
| ST7789 ½/¾/1:1 buttons on the OUT screen | `scale` segmented config field (`Inspector`, `panelZoom`) |
| `BL ON/OFF` toggle on the OUT screen | `backlight` toggle config field |
| CFG pin rows in the canvas node | Inspector "Pin map" table |
| Node "class" badge / glyph | Inspector heading (`designator`, `category`) |

The build‑button label progression (`Compiling… → Linking… → Flashed ✓`) **does
match** the design — `BUTTON_LABELS` in `shared/build.ts`. Not a gap.

---

## C. Delivered beyond the design (no action)

- Real QEMU emulator with ▶ / ■ / ⟳ transport controls and live status
- Real PlatformIO project: open a checkout, live file tree, on‑disk dirty marks,
  syntax highlighting, click‑diagnostic‑to‑source
- Serial **input** (design shows only a blinking cursor)
- **Flash over USB** (`⌘⇧U`) — dialog, port picker, esptool runner
- Runtime board picker + second board (Heltec Wireless Paper)
- Dock resize (drag + keyboard), grid style (dot/line/none), snap‑to‑grid
- Agent control plane (ACP + loopback MCP) — no UI surface yet (`[tracked]`:
  "Agent session dock panel")
- Native window chrome / traffic‑light‑aware title bar

---

## Suggested order

1. Low‑effort, high‑visibility, `[untracked]`: Verify button + port label, Export
   `board_m9.h` menu item, wire up / hide dead Help items, Dock meta line.
2. Inspector parity: Identity, Nets, Firmware‑hook card + Reveal‑in‑source.
3. Canvas presentation: net labels + bus‑labels toggle, SPI toast, stats chip.
4. Canvas node cards with CFG/IN/OUT — larger; overlaps the `[tracked]` canvas
   editing milestone, do together.
5. Bus filter chips.
6. Library groups + place affordance — with generic parts + canvas editing.
