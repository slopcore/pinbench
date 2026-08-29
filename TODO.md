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

> **Update (branch `usb-flash`):** every item in section A is now built and
> unit‑tested (tiers 1–8). The pin header **is** written into the checkout on
> Build & flash (`include/<boardId>_pins.h`, skipped if the on‑disk file has no
> PinBench sentinel), and **File ▸ Import pin header** reads a `.h` back and
> applies it as canvas rebind edits. Wiring each keyboard/stimulus command into
> the QEMU‑side device model is the remaining follow‑on (the panels render and
> send the commands; a model consumes what it understands).

### Canvas

- [x] **Rich node cards with a CFG / IN / OUT tab strip.** `foreignObject` HTML
      card: header (glyph, designator + name, class badge), `CFG|IN|OUT` strip,
      body switches pin rows / stimulus note / pin+bus summary. — `Canvas.tsx`
- [x] **Net labels on the canvas.** Pill‑boxed midpoint labels from
      `NetDefinition.label`. — `Canvas.tsx`, `canvas.css`
- [x] **Dismissible "Shared SPI bus" toast** (top‑right), shown when an SPI bus
      carries more than one peripheral. — `Canvas.tsx`
- [x] **Canvas stats overlay chip** (bottom‑left), reuses `boardTotals`. —
      `Canvas.tsx`
- [x] **Bus‑labels visibility toggle** (View ▸ "Bus labels", key `L`). —
      `shared/commands.ts`, `shared/workspace.ts`, `Canvas.tsx`
- [x] Canvas editing: **drag parts** (Select tool, snap to grid), **Draw‑net
      tool** (click two cards), **Probe‑pin tool** (selects), **`⌘Z`/`⇧⌘Z`**
      undo/redo, **persist edits** in `ProjectFile.boardEdits` (replayed on
      open, stale edits skipped). `useBoardEditor` folds the edits into the
      board the canvas/Inspector/Library/Verify/export all read. — `Canvas.tsx`,
      `state/useBoardEditor.ts`, `shared/boardEdit.ts`, `shared/project.ts`.
      Build & flash writes the generated header into the checkout
      (`include/<boardId>_pins.h`) before `pio run`, honouring the codegen
      divergence guard. — `src/main/build.ts`, `src/main/index.ts`

### Inspector

- [x] **Identity section** — Reference / Class / Position rows. — `Inspector.tsx`
- [x] **Nets (N) section** — one row per connected net, swatch coloured by bus
      kind via shared `netColour()`. — `Inspector.tsx`, `shared/nets.ts`
- [x] **Firmware hook card + "Reveal in source" button** — new optional
      `PartDefinition.firmwareHook { symbol, file?, line?, note? }`, validated by
      `parseBoard`, populated (symbol + note) for the radio/display/GNSS/keyboard
      parts in both board JSONs. The card renders; **the "Reveal in source"
      button appears only when a hook carries a `file`**, and none of the
      shipped hooks do yet — the MeshCore source paths are not verified against a
      checkout, so they were left out rather than guessed. Add `file`/`line` per
      hook once a firmware tree is wired in. — `Inspector.tsx`, `shared/board.ts`
- [x] Per‑part IN panel for every model — `shared/stimuli.ts` drives a generic
      button panel (MCU reset/boot straps, SD card insert/remove + faults, GNSS
      NMEA scenarios, sensor‑cluster RTC/IMU/magnetometer, power battery/charger/
      buzzer, USB console replay, button press/hold). LR1110 keeps its rich
      panel. — `InPanel.tsx`, `shared/stimuli.ts`. Consuming each command in the
      QEMU model is follow‑on.
- [x] Keyboard IN panel — QWERTY matrix + D‑pad + HOME/BACK/MENU/CHAT/MAP/LOC
      shortcut keys + a live key‑buffer readout; every key sends `key`. —
      `InPanel.tsx` (`KeyboardInPanel`)
- [ ] LCD OUT panel: ½ / ¾ / 1:1 zoom buttons and a `BL ON/OFF` toggle on the
      panel itself. **Relocated**, see section B — not a true gap.

### Toolbar & menus

- [x] **Bus filter chips** (SPI / I2C / UART / GPIO toggles) in the toolbar —
      dim nets of a bus via `canvas.hiddenBuses`. — `Toolbar.tsx`, `Canvas.tsx`,
      `shared/workspace.ts`
- [x] **"Verify" button** and **port label** — always‑visible Verify button;
      status‑bar port label from `pio device list`. — `Toolbar.tsx`,
      `StatusBar.tsx`, `App.tsx`
- [x] **File ▸ Export pin header… (⌘⇧E).** New `board:export-pin-header` IPC
      writes `generatePinHeader()` to a path the user picks. — `shared/commands.ts`,
      `src/main/index.ts`, `App.tsx`
- [x] **Edit menu semantics.** Reworked to Undo / Redo / Duplicate part / Delete
      part / Auto‑arrange by bus, all enabled and handled in `runCommand`
      (`duplicatePart`, `autoArrangeByBus` in `shared/boardEdit.ts`).
      Cut/Copy/Paste/Select‑all stay inert. — `shared/commands.ts`, `App.tsx`
- [x] **Dead Help items.** `help.shortcuts` / `help.about` now open a `HelpSheet`
      (shortcut list built from the shared command table; About from `AppInfo`).
      A guard test fires every enabled menu item through `runCommand`. — `App.tsx`,
      `components/HelpSheet.tsx`
- [x] Help ▸ **Project wiki** / **User guide** links added (main‑process
      `shell.openExternal`, like Documentation). — `shared/commands.ts`,
      `src/main/menu.ts`
- [x] **File ▸ Import pin header…** — reads a `.h` in the exact format
      `generatePinHeader` emits and folds it back onto the board as `rebindPin`
      edits (`pinHeaderChanges` in `shared/codegen.ts`), the round trip for a
      header hand‑edited outside PinBench. Replaces the design mock's fabricated
      "Import M9 pinout". — `shared/commands.ts`, `src/main/index.ts`, `App.tsx`

### Library

- [x] **"Expansion · generic" group** (LED, button, NeoPixel, DHT22, servo) and
      **"Firmware modules" group** (MeshCore stack, Home page UI, Storage/FS)
      from `shared/catalogue.ts`. Clicking an entry adds it to the board via an
      `addPart` canvas edit. — `LibraryPanel.tsx`, `shared/catalogue.ts`
- [x] **`＋` place affordance** on each row and the footer hint. Board rows
      select; catalogue rows drop the part on the canvas. — `LibraryPanel.tsx`

### Dock

- [x] **Dock meta line** (`115200 8N1` on Serial, `N messages` on Diagnostics)
      in the tab strip. — `components/Dock.tsx`
- [x] **Collapse chevron** — collapses the dock to its tab strip via
      `workspace.dockCollapsed`; the `×` still hides it entirely. —
      `components/Dock.tsx`, `shared/workspace.ts`

---

## B. Relocated — built, different home (confirm these are deliberate)

| Design location                            | Delivered location                                        |
| ------------------------------------------ | --------------------------------------------------------- |
| IN / OUT tabs inside the canvas node       | Inspector sections (`InPanel` / `OutPanel`)               |
| Board chip in the top bar                  | Status‑bar `<select>` picker (`StatusBar.tsx`)            |
| Canvas overlay: parts · nets · GPIO totals | Status bar totals (`boardTotals`)                         |
| ST7789 ½/¾/1:1 buttons on the OUT screen   | `scale` segmented config field (`Inspector`, `panelZoom`) |
| `BL ON/OFF` toggle on the OUT screen       | `backlight` toggle config field                           |
| CFG pin rows in the canvas node            | Inspector "Pin map" table                                 |
| Node "class" badge / glyph                 | Inspector heading (`designator`, `category`)              |

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
