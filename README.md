# Style Selector — ComfyUI Custom Node

A node with a thumbnail gallery. Point it at a folder of paired
`styleN.png` + `styleN.txt` files, pick a style either by clicking a
thumbnail or by number, and it outputs:
- **`prompt`** — the matching `.txt` content
- **`style_name`** — just the filename of the selected style (e.g. `style3`), handy for filenames, labels, or logging which style was used

## Install

1. Copy this whole `style_selector` folder into `ComfyUI/custom_nodes/`.
2. Restart ComfyUI (a fresh restart, not just a browser refresh — it needs
   to register the new API routes and load the JS extension).
3. Search for "Style Selector" when adding a node (category: `utils/style_selector`).

## Folder format

```
my_styles/
├── style1.png
├── style1.txt
├── portraits/
│   ├── style2.png
│   ├── style2.txt
│   ├── style3.txt          # text-only, no preview image yet
```

- Subfolders are scanned recursively and shown as collapsible category
  groups in the gallery (folder name = category label; the top-level
  folder itself is labeled `(root)`).
- A `.txt` file is required for a style to be selectable/numbered — that's
  what gets output as the prompt.
- A `.png` **without** a matching `.txt` is shown greyed out, unclickable,
  and unnumbered (there's nothing for it to output).
- A `.txt` **without** a matching `.png` is fully clickable/numbered and
  shown with a "no preview" placeholder icon — handy while you're still
  generating preview images for a batch of new styles.

## Selecting a style: `style_number`

Instead of a hidden click-only selection, the node exposes a normal
**`style_number`** INT input — the same kind of widget KSampler uses for
`seed`, including the **fixed / increment / decrement / randomize**
dropdown next to it. Numbers are assigned in the same order as the
gallery (category, then name alphabetically), counting only styles that
have a `.txt` file.

This means you can **batch-render a range of styles**:
1. Set `style_number` to the start of your range (e.g. `10`).
2. Set the control mode next to it to **increment**.
3. Use ComfyUI's queue-multiple-times option (the little arrow next to the
   Queue button → "Batch count", or just click Queue repeatedly) to run it
   11 times — style 10 the first run, 11 the next, up through 20.

Clicking a thumbnail in the gallery sets `style_number` to match (and
updates the highlighted tile), and typing/incrementing the number directly
does the reverse — the gallery highlight follows along either way.

## Using the node

1. Paste a folder path into the `folder_path` field. If you've used this
   node before, it auto-fills with the last folder you loaded (stored in
   your browser, not the workflow).
2. Click **Reload Styles** — scans the folder, numbers the selectable
   styles, and populates the gallery. Also auto-loads on node creation if
   a remembered folder is present.
3. Use the **filter box** to narrow down by name — useful once you have a
   lot of styles across many subfolders.
4. Click a category header to collapse/expand that group.
5. Adjust `thumbnail_size` to resize thumbnails instantly (no reload needed).
6. Click a thumbnail (or placeholder icon), or set `style_number` directly —
   blue outline = currently selected style.
7. Wire `prompt` into a CLIPTextEncode (or wherever you want the text), and
   `style_name` anywhere you want to know/display which style was picked
   (e.g. into a filename-prefix node, or a text overlay).

## How it works (for future edits)

- `nodes.py`:
  - `StyleSelector` node class: `STRING`/`INT`/`INT` inputs → `STRING`,`STRING` outputs.
  - `_scan_folder()` walks the folder tree with `os.walk`, grouping files by
    `(subfolder, stem)`, and returns them sorted by `(category, name)`.
    Each style gets an `id` like `"style1"` or `"portraits/style3"`
    (forward-slash relative path, no extension), used to resolve files.
  - `get_prompt()` re-scans the folder, filters to styles with `has_text`,
    and indexes into that filtered list with `style_number - 1` (clamped
    into range so an out-of-range batch just holds on the last style
    instead of erroring).
  - `_resolve_safe()` is used by both the thumbnail route and `get_prompt()`
    — it rejects `..`/absolute segments so a crafted name can't read files
    outside the chosen folder.
  - Two `aiohttp` routes on `PromptServer.instance.routes`:
    - `GET /style_selector/list?folder=...` → JSON list of `{id, name, category, has_image, has_text}`
    - `GET /style_selector/thumbnail?folder=...&name=...` → serves the raw PNG
- `web/style_selector.js`: a ComfyUI frontend extension hooking `onNodeCreated`
  for the `StyleSelector` node type. Adds a DOM widget (gallery) built from
  plain HTML — category sections, a filter input, and per-style tiles
  (image or placeholder). After loading, it numbers styles client-side in
  the exact same order/filter as the backend (`has_text` styles only, in
  scan order) so the numbers always match what `get_prompt()` will select.
  Clicking a tile sets the real `style_number` widget's value (triggering
  its callback so ComfyUI/other extensions see the change) and updates the
  highlighted border directly, without rebuilding the gallery; typing
  directly into `style_number` does the same in reverse. Last-used folder
  is saved to `localStorage` under `Comfy.StyleSelector.lastFolder`, and
  scroll position per-folder under `Comfy.StyleSelector.scrollTop:<folder>`.

## Notes on recent fixes

- **Default control mode**: `style_number`'s control-after-generate now
  defaults to **fixed** instead of the implicit `randomize` default that
  ComfyUI otherwise applies to control-enabled INT widgets.
- **Randomize going out of range**: `style_number`'s `max` is no longer a
  static `999999` — after every folder load, the widget's `min`/`max` are
  updated to the actual selectable-style count, so `randomize` (and manual
  typing) can't land on a number with nothing behind it.
- **Node width resetting on tab switch**: the old code called
  `node.setSize(node.computeSize())` unconditionally on every node
  (re)creation, which clobbered whatever width you'd manually resized to
  (height was fine because `computeSize()` for the gallery widget grows
  with the node anyway). It now only ever grows height if needed and always
  preserves the existing width.
- **Double-click lightbox not firing**: the real bug — every single click
  (selecting a style) called `renderGallery()`, a full teardown/rebuild of
  the gallery DOM. During a double-click, that rebuild ran mid-sequence and
  destroyed the very `<img>` the browser was tracking for the double-click,
  so `dblclick` rarely fired. Selecting a style now calls a lightweight
  `updateHighlight()` that only toggles a tile's border color in place —
  the DOM (and its listeners) stays untouched, so double-click works
  reliably, and single-click no longer causes any visible flicker either.
- **Scroll position resetting on tab switch**: switching tabs reconstructs
  the node (same reason width used to reset), so a plain in-memory
  `scrollTop` can't survive it. Scroll position is now saved to
  `localStorage` (debounced, keyed by folder path) as you scroll, and
  restored after the gallery reloads.

## Known limitations / possible future extensions

- Thumbnails are served at full resolution (no server-side resizing) — fine
  for reasonably sized PNGs; for very large images, add Pillow-based
  resizing in the `/thumbnail` route.
- No caching — folder is rescanned on every "Reload Styles" click, and
  again inside `get_prompt()` on every queued run. Fine for a few hundred
  files; for huge libraries, consider caching the scan with an mtime check.
- Numbering is scan-order-based, not stored per-file — adding or removing
  styles shifts the numbers of everything after them. If you need stable
  IDs regardless of folder edits, we'd want to add explicit numeric
  prefixes to filenames instead of deriving order from a live scan.
- No file-system browser for `folder_path` — it's a raw text field.
- Category collapse state resets when the node is recreated (not persisted).
