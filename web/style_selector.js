import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const LAST_FOLDER_KEY = "Comfy.StyleSelector.lastFolder";
const SCROLL_KEY_PREFIX = "Comfy.StyleSelector.scrollTop:";
const ROW_HEIGHT = (typeof LiteGraph !== "undefined" && LiteGraph.NODE_WIDGET_HEIGHT) || 20;

function scrollKeyFor(folder) {
    return SCROLL_KEY_PREFIX + folder;
}

app.registerExtension({
    name: "StyleSelector.Gallery",

    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name !== "StyleSelector") return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            onNodeCreated?.apply(this, arguments);
            const node = this;

            // ---------------------------------------------------------
            // DOM structure - a flex column that fills whatever height
            // the DOM widget is given. Only `list` scrolls internally.
            // ---------------------------------------------------------
            const wrapper = document.createElement("div");
            wrapper.style.display = "flex";
            wrapper.style.flexDirection = "column";
            wrapper.style.height = "100%";
            wrapper.style.width = "100%";
            wrapper.style.boxSizing = "border-box";
            wrapper.style.gap = "4px";

            const reloadRow = document.createElement("div");
            reloadRow.style.display = "flex";
            reloadRow.style.flex = "0 0 auto";

            const reloadBtn = document.createElement("button");
            reloadBtn.textContent = "Reload Styles";
            reloadBtn.style.width = "100%";
            reloadBtn.style.padding = "4px 0";
            reloadRow.appendChild(reloadBtn);

            const filterRow = document.createElement("div");
            filterRow.style.flex = "0 0 auto";

            const searchInput = document.createElement("input");
            searchInput.type = "text";
            searchInput.placeholder = "Filter styles by name...";
            searchInput.style.boxSizing = "border-box";
            searchInput.style.width = "100%";
            searchInput.style.background = "#222";
            searchInput.style.color = "#ddd";
            searchInput.style.border = "1px solid #444";
            searchInput.style.borderRadius = "4px";
            searchInput.style.padding = "4px 6px";
            searchInput.style.fontSize = "11px";
            filterRow.appendChild(searchInput);

            const status = document.createElement("div");
            status.textContent = "Enter a folder path above, then reload.";
            status.style.flex = "0 0 auto";
            status.style.color = "#999";
            status.style.fontSize = "11px";

            const list = document.createElement("div");
            list.style.flex = "1 1 auto";
            list.style.minHeight = "0"; // required for a flex child to actually scroll
            list.style.overflowY = "auto";
            list.style.background = "#161616";
            list.style.border = "1px solid #333";
            list.style.borderRadius = "6px";
            list.style.padding = "6px";
            list.style.display = "flex";
            list.style.flexDirection = "column";
            list.style.gap = "8px";

            wrapper.appendChild(reloadRow);
            wrapper.appendChild(filterRow);
            wrapper.appendChild(status);
            wrapper.appendChild(list);

            const galleryDomWidget = node.addDOMWidget("style_gallery_ui", "div", wrapper, {
                serialize: false,
                hideOnZoom: false,
            });

            // Make the DOM widget's own height track the node's current size,
            // so dragging the node's resize handle actually grows the gallery
            // instead of leaving dead space below a fixed-height box.
            galleryDomWidget.computeSize = function (width) {
                const nodeHeight = node.size ? node.size[1] : 300;
                const chromeAbove =
                    (reloadRow.offsetHeight || ROW_HEIGHT) +
                    (filterRow.offsetHeight || ROW_HEIGHT) +
                    (status.offsetHeight || 16) +
                    // rows above this DOM widget in the node itself:
                    // folder_path + thumbnail_size + style_number (all visible)
                    3 * (ROW_HEIGHT + 4) +
                    30; // node padding / gaps fudge factor
                const available = Math.max(160, nodeHeight - chromeAbove);
                return [width, available];
            };

            // ---------------------------------------------------------
            // State
            // ---------------------------------------------------------
            const getWidget = (name) => node.widgets.find((w) => w.name === name);
            let cachedStyles = [];
            let collapsed = {};
            let filterText = "";
            let renderedTiles = []; // [{el, style}] - populated by renderGallery, used by updateHighlight

            // ---------------------------------------------------------
            // Folder persistence
            // ---------------------------------------------------------
            const folderWidget = getWidget("folder_path");
            if (folderWidget && !folderWidget.value) {
                const last = localStorage.getItem(LAST_FOLDER_KEY);
                if (last) folderWidget.value = last;
            }
            if (folderWidget) {
                const origFolderCallback = folderWidget.callback;
                folderWidget.callback = function (...args) {
                    origFolderCallback?.apply(this, args);
                    if (folderWidget.value) {
                        localStorage.setItem(LAST_FOLDER_KEY, folderWidget.value);
                    }
                };
            }

            // ---------------------------------------------------------
            // Loading
            // ---------------------------------------------------------
            async function loadStyles() {
                const folder = getWidget("folder_path")?.value?.trim();
                if (!folder) {
                    status.textContent = "No folder set.";
                    list.innerHTML = "";
                    return;
                }
                status.textContent = "Loading...";
                try {
                    const res = await api.fetchApi(
                        `/style_selector/list?folder=${encodeURIComponent(folder)}`
                    );
                    const data = await res.json();
                    if (data.error) {
                        status.textContent = "Error: " + data.error;
                        list.innerHTML = "";
                        return;
                    }
                    cachedStyles = data.styles || [];
                    let n = 1;
                    for (const s of cachedStyles) {
                        s.number = s.has_text ? n++ : null;
                    }
                    const selectableCount = n - 1;

                    const numberWidget = getWidget("style_number");
                    if (numberWidget) {
                        numberWidget.options = numberWidget.options || {};
                        numberWidget.options.min = 1;
                        // Cap "randomize" (and manual typing) to the actual
                        // number of selectable styles instead of the wide
                        // static fallback (999999) set in INPUT_TYPES.
                        numberWidget.options.max = Math.max(1, selectableCount);
                        if (numberWidget.value > numberWidget.options.max) {
                            numberWidget.value = numberWidget.options.max;
                        }
                    }

                    localStorage.setItem(LAST_FOLDER_KEY, folder);
                    status.textContent = `${cachedStyles.length} style(s) found (${selectableCount} selectable)`;
                    renderGallery();

                    // renderGallery() just rebuilt the whole list (scrollTop
                    // resets to 0 whenever we do that) - restore whatever
                    // scroll position was saved for this folder, once the
                    // browser has actually laid out the new content.
                    const savedScroll = localStorage.getItem(scrollKeyFor(folder));
                    if (savedScroll) {
                        requestAnimationFrame(() => {
                            list.scrollTop = parseFloat(savedScroll) || 0;
                        });
                    }
                } catch (err) {
                    status.textContent = "Failed to reach server.";
                    console.error("StyleSelector load error:", err);
                }
            }

            function buildPlaceholder(size) {
                const ph = document.createElement("div");
                ph.style.width = "100%";
                ph.style.height = size + "px";
                ph.style.display = "flex";
                ph.style.alignItems = "center";
                ph.style.justifyContent = "center";
                ph.style.background = "#2a2a2a";
                ph.style.border = "1px dashed #555";
                ph.style.borderRadius = "4px";
                ph.style.color = "#777";
                ph.style.fontSize = Math.max(9, Math.min(28, size * 0.18)) + "px";
                ph.style.textAlign = "center";
                ph.style.lineHeight = "1.2";
                ph.innerHTML = "&#128196;<br>no preview";
                return ph;
            }

            function openLightbox(src, title) {
                const overlay = document.createElement("div");
                overlay.style.position = "fixed";
                overlay.style.inset = "0";
                overlay.style.background = "rgba(0,0,0,0.88)";
                overlay.style.zIndex = "999999";
                overlay.style.display = "flex";
                overlay.style.flexDirection = "column";
                overlay.style.alignItems = "center";
                overlay.style.justifyContent = "center";
                overlay.style.cursor = "zoom-out";

                const img = document.createElement("img");
                img.src = src;
                img.style.maxWidth = "92vw";
                img.style.maxHeight = "85vh";
                img.style.objectFit = "contain";
                img.style.boxShadow = "0 0 40px rgba(0,0,0,0.7)";
                img.style.borderRadius = "4px";

                const caption = document.createElement("div");
                caption.textContent = title;
                caption.style.color = "#eee";
                caption.style.marginTop = "12px";
                caption.style.fontSize = "13px";
                caption.style.letterSpacing = "0.02em";

                const hint = document.createElement("div");
                hint.textContent = "click or press Esc to close";
                hint.style.color = "#777";
                hint.style.marginTop = "4px";
                hint.style.fontSize = "11px";

                overlay.appendChild(img);
                overlay.appendChild(caption);
                overlay.appendChild(hint);

                const close = () => {
                    overlay.remove();
                    document.removeEventListener("keydown", onKey);
                };
                const onKey = (e) => {
                    if (e.key === "Escape") close();
                };
                overlay.onclick = close;
                document.addEventListener("keydown", onKey);

                document.body.appendChild(overlay);
            }

            function renderGallery() {
                list.innerHTML = "";
                renderedTiles = [];
                const folder = getWidget("folder_path")?.value?.trim();
                const size = getWidget("thumbnail_size")?.value || 128;
                const numberWidget = getWidget("style_number");
                const selectedNumber = numberWidget?.value;

                if (cachedStyles.length === 0) {
                    const empty = document.createElement("div");
                    empty.textContent = "No matching .png/.txt files found.";
                    empty.style.color = "#777";
                    empty.style.fontSize = "11px";
                    list.appendChild(empty);
                    return;
                }

                const needle = filterText.trim().toLowerCase();
                const filtered = needle
                    ? cachedStyles.filter((s) => s.name.toLowerCase().includes(needle))
                    : cachedStyles;

                if (filtered.length === 0) {
                    const empty = document.createElement("div");
                    empty.textContent = "No styles match your filter.";
                    empty.style.color = "#777";
                    empty.style.fontSize = "11px";
                    list.appendChild(empty);
                    return;
                }

                const byCategory = new Map();
                for (const style of filtered) {
                    const cat = style.category || "";
                    if (!byCategory.has(cat)) byCategory.set(cat, []);
                    byCategory.get(cat).push(style);
                }

                for (const [category, items] of byCategory.entries()) {
                    const section = document.createElement("div");

                    const header = document.createElement("div");
                    header.style.display = "flex";
                    header.style.alignItems = "center";
                    header.style.gap = "4px";
                    header.style.cursor = "pointer";
                    header.style.color = "#aaa";
                    header.style.fontSize = "11px";
                    header.style.fontWeight = "bold";
                    header.style.userSelect = "none";
                    header.style.padding = "2px 0";

                    const isCollapsed = !!collapsed[category];
                    const arrow = document.createElement("span");
                    arrow.textContent = isCollapsed ? "\u25B6" : "\u25BC";
                    const label = document.createElement("span");
                    label.textContent = category === "" ? "(root)" : category;
                    const count = document.createElement("span");
                    count.textContent = `(${items.length})`;
                    count.style.color = "#666";

                    header.appendChild(arrow);
                    header.appendChild(label);
                    header.appendChild(count);
                    header.onclick = () => {
                        collapsed[category] = !collapsed[category];
                        renderGallery();
                    };

                    section.appendChild(header);

                    if (!isCollapsed) {
                        const grid = document.createElement("div");
                        grid.style.display = "flex";
                        grid.style.flexWrap = "wrap";
                        grid.style.gap = "6px";
                        grid.style.marginTop = "4px";

                        for (const style of items) {
                            const tile = buildItem(style, folder, size, selectedNumber, numberWidget);
                            renderedTiles.push({ el: tile, style });
                            grid.appendChild(tile);
                        }

                        section.appendChild(grid);
                    }

                    list.appendChild(section);
                }
            }

            function updateHighlight() {
                const selectedNumber = getWidget("style_number")?.value;
                for (const { el, style } of renderedTiles) {
                    el.style.border =
                        style.number !== null && style.number === selectedNumber
                            ? "2px solid #5ab0ff"
                            : "2px solid transparent";
                }
            }

            function buildItem(style, folder, size, selectedNumber, numberWidget) {
                const item = document.createElement("div");
                item.style.width = size + "px";
                item.style.textAlign = "center";
                item.style.padding = "3px";
                item.style.borderRadius = "6px";
                item.style.border =
                    style.number !== null && style.number === selectedNumber
                        ? "2px solid #5ab0ff"
                        : "2px solid transparent";

                const clickable = style.has_text;
                item.style.cursor = clickable ? "pointer" : "default";
                item.style.opacity = clickable ? "1" : "0.4";
                item.title = clickable
                    ? `#${style.number} - ${style.name}`
                    : `${style.name} (missing .txt file)`;

                if (style.has_image) {
                    const img = document.createElement("img");
                    const fullSrc = `/style_selector/thumbnail?folder=${encodeURIComponent(
                        folder
                    )}&name=${encodeURIComponent(style.id)}`;
                    img.src = fullSrc;
                    img.style.width = "100%";
                    img.style.height = size + "px";
                    img.style.objectFit = "cover";
                    img.style.borderRadius = "4px";
                    img.style.display = "block";
                    img.draggable = false;
                    img.ondblclick = (e) => {
                        e.stopPropagation();
                        openLightbox(fullSrc, `#${style.number ?? "-"} ${style.name}`);
                    };
                    item.appendChild(img);
                } else {
                    item.appendChild(buildPlaceholder(size));
                }

                const nameLabel = document.createElement("div");
                nameLabel.textContent = clickable ? `#${style.number} ${style.name}` : style.name;
                nameLabel.style.color = "#ccc";
                nameLabel.style.fontSize = "10px";
                nameLabel.style.whiteSpace = "nowrap";
                nameLabel.style.overflow = "hidden";
                nameLabel.style.textOverflow = "ellipsis";
                nameLabel.style.marginTop = "2px";
                item.appendChild(nameLabel);

                if (clickable) {
                    item.onclick = () => {
                        if (numberWidget) {
                            numberWidget.value = style.number;
                            numberWidget.callback?.(style.number);
                        }
                        updateHighlight();
                    };
                }

                return item;
            }

            // ---------------------------------------------------------
            // Wiring
            // ---------------------------------------------------------
            reloadBtn.onclick = loadStyles;

            let scrollSaveTimer = null;
            list.addEventListener("scroll", () => {
                clearTimeout(scrollSaveTimer);
                scrollSaveTimer = setTimeout(() => {
                    const folder = getWidget("folder_path")?.value?.trim();
                    if (folder) {
                        localStorage.setItem(scrollKeyFor(folder), String(list.scrollTop));
                    }
                }, 150);
            });

            searchInput.addEventListener("input", () => {
                filterText = searchInput.value;
                renderGallery();
            });

            const sizeWidget = getWidget("thumbnail_size");
            if (sizeWidget) {
                const origCallback = sizeWidget.callback;
                sizeWidget.callback = function (...args) {
                    origCallback?.apply(this, args);
                    renderGallery();
                };
            }

            // Keep the gallery's highlight in sync when the user manually
            // types/increments style_number directly (not just via clicks).
            // Uses the lightweight updateHighlight() rather than a full
            // renderGallery() rebuild - both to avoid unnecessary teardown
            // and because this same callback also fires from tile clicks.
            const numberWidget = getWidget("style_number");
            if (numberWidget) {
                const origNumberCallback = numberWidget.callback;
                numberWidget.callback = function (...args) {
                    origNumberCallback?.apply(this, args);
                    updateHighlight();
                };
            }

            requestAnimationFrame(() => {
                // Only touch height (to make room for the gallery on first
                // add). Never overwrite width - doing so was clobbering the
                // width the user had resized to every time the node got
                // reconstructed (e.g. switching workflow tabs), even though
                // height was preserved fine.
                const computed = node.computeSize();
                const width = node.size ? node.size[0] : computed[0];
                const height = node.size ? Math.max(node.size[1], computed[1]) : computed[1];
                node.setSize([width, height]);
                if (getWidget("folder_path")?.value) {
                    loadStyles();
                }
            });
        };
    },
});
