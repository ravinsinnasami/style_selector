import os
from aiohttp import web
from server import PromptServer

# Priority order when a style has more than one image file for the same
# stem (e.g. both style1.png and style1.jpg) - first match wins.
IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".webp"]


class StyleSelector:
    """
    Reads a folder (recursively) of paired files (style1.png/.jpg/.webp +
    style1.txt, etc.) and outputs the text content of whichever style is
    selected via the thumbnail gallery in the frontend widget.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "folder_path": ("STRING", {"default": "", "multiline": False}),
                "thumbnail_size": ("INT", {
                    "default": 128, "min": 48, "max": 512, "step": 8
                }),
                # 1-based index into the folder's styles, sorted the same way
                # as the gallery (category, then name). Clicking a thumbnail
                # in the gallery sets this to match. control_after_generate
                # gives it the same increment/decrement/randomize controls as
                # a KSampler's "seed" widget, so batches (e.g. queue 11 times
                # with increment) sweep through a range of styles.
                "style_number": ("INT", {
                    "default": 1, "min": 1, "max": 999999,
                    "control_after_generate": "fixed",
                }),
            }
        }

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("prompt", "style_name")
    FUNCTION = "get_prompt"
    CATEGORY = "utils/style_selector"

    def get_prompt(self, folder_path, thumbnail_size, style_number):
        styles = _scan_folder(folder_path) if folder_path and os.path.isdir(folder_path) else []
        selectable = [s for s in styles if s["has_text"]]

        if not selectable:
            print("[StyleSelector] Warning: no selectable styles (.txt files) found")
            return ("", "")

        # style_number is 1-based; clamp into range rather than erroring out,
        # so a batch sweeping past the last style just holds on the last one.
        index = max(1, min(style_number, len(selectable))) - 1
        style = selectable[index]

        txt_path = _resolve_safe(folder_path, style["id"], ".txt")
        if not txt_path or not os.path.isfile(txt_path):
            print(f"[StyleSelector] Warning: text file not found for '{style['id']}'")
            return ("", style["name"])

        with open(txt_path, "r", encoding="utf-8") as f:
            return (f.read(), style["name"])


NODE_CLASS_MAPPINGS = {
    "StyleSelector": StyleSelector,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "StyleSelector": "Style Selector",
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _resolve_safe(folder: str, rel_id: str, ext: str):
    """
    Resolve `<folder>/<rel_id><ext>` while refusing to escape `folder`.
    rel_id uses forward slashes for subfolders, e.g. "portraits/style3".
    Returns an absolute path, or None if invalid/unsafe.
    """
    if not folder or not rel_id:
        return None

    parts = rel_id.split("/")
    if any(p in ("", ".", "..") for p in parts):
        return None

    folder_abs = os.path.abspath(folder)
    full = os.path.abspath(os.path.join(folder_abs, *parts)) + ext

    if full != folder_abs and not full.startswith(folder_abs + os.sep):
        return None
    return full


def _scan_folder(root: str):
    """
    Recursively walk `root`, grouping files by (subfolder, stem).
    Returns a flat list of style dicts:
      { id, name, category, has_image, has_text }
    `id` is the relative path (forward slashes) used to reference the style,
    e.g. "style1" or "portraits/style3".
    `category` is the relative subfolder ("" for the root folder itself).
    """
    styles = []
    for dirpath, dirnames, filenames in os.walk(root):
        # skip hidden directories (e.g. .git, .DS_Store folders)
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]

        rel_dir = os.path.relpath(dirpath, root)
        rel_dir = "" if rel_dir == "." else rel_dir.replace(os.sep, "/")

        stems = {}
        for fname in filenames:
            base, ext = os.path.splitext(fname)
            ext = ext.lower()
            if ext not in IMAGE_EXTS and ext != ".txt":
                continue
            entry = stems.setdefault(base, {"image_exts": set(), "txt": False})
            if ext == ".txt":
                entry["txt"] = True
            else:
                entry["image_exts"].add(ext)

        for stem, flags in stems.items():
            style_id = stem if rel_dir == "" else f"{rel_dir}/{stem}"
            # Pick the highest-priority image extension present, if any
            # (png > jpg/jpeg > webp), so has_image/thumbnail lookups don't
            # need to know or care which format was actually used.
            image_ext = next((e for e in IMAGE_EXTS if e in flags["image_exts"]), None)
            styles.append({
                "id": style_id,
                "name": stem,
                "category": rel_dir,
                "has_image": image_ext is not None,
                "image_ext": image_ext,
                "has_text": flags["txt"],
            })

    styles.sort(key=lambda s: (s["category"].lower(), s["name"].lower()))
    return styles


# ---------------------------------------------------------------------------
# API routes used by the frontend gallery widget (web/style_selector.js)
# ---------------------------------------------------------------------------

routes = PromptServer.instance.routes


@routes.get("/style_selector/list")
async def style_selector_list(request):
    folder = request.rel_url.query.get("folder", "").strip()

    if not folder:
        return web.json_response({"error": "No folder specified"})
    if not os.path.isdir(folder):
        return web.json_response({"error": f"Folder not found: {folder}"})

    try:
        styles = _scan_folder(folder)
    except Exception as e:
        return web.json_response({"error": str(e)})

    return web.json_response({"styles": styles})


@routes.get("/style_selector/thumbnail")
async def style_selector_thumbnail(request):
    folder = request.rel_url.query.get("folder", "").strip()
    name = request.rel_url.query.get("name", "").strip()

    if not folder or not os.path.isdir(folder):
        return web.Response(status=404, text="Folder not found")

    for ext in IMAGE_EXTS:
        full_path = _resolve_safe(folder, name, ext)
        if full_path and os.path.isfile(full_path):
            return web.FileResponse(full_path, headers={"Cache-Control": "no-cache"})

    return web.Response(status=404, text="Image not found")
