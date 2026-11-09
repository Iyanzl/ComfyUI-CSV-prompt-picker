// SPDX-License-Identifier: GPL-3.0-only
// Modified 2026-11-09: CSV editing UI and live refresh.
// Thanks to vslinx/ComfyUI-vslinx-nodes; see ACKNOWLEDGEMENTS.md.
import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { showCsvEditor } from "./csv_editor.js";
const NODE_NAME = "CSV_MultiLangPromptPicker";
function toast(severity, summary, detail, life = 3000) {
  const t = app.extensionManager?.toast;
  if (t?.add) {
    t.add({ severity, summary, detail, life });
    return;
  }
  const fn =
    severity === "error" ? console.error :
      severity === "warn" ? console.warn :
        console.log;
  fn(`[${summary}] ${detail}`);
}
function ellipsizeToWidth(ctx, text, maxWidth) {
  text = String(text ?? "");
  if (maxWidth <= 0) return "";
  if (ctx.measureText(text).width <= maxWidth) return text;
  const ellipsis = "…";
  const ellW = ctx.measureText(ellipsis).width;
  if (ellW >= maxWidth) return "";
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = text.slice(0, mid) + ellipsis;
    if (ctx.measureText(candidate).width <= maxWidth) lo = mid + 1;
    else hi = mid;
  }
  const cut = Math.max(0, lo - 1);
  return text.slice(0, cut) + ellipsis;
}
function drawClippedText(ctx, text, x, yMid, w, h) {
  const padX = 10;
  const padY = 2;
  ctx.save();
  ctx.beginPath();
  ctx.rect(
    x + padX,
    yMid - h / 2 + padY,
    Math.max(0, w - padX * 2),
    Math.max(0, h - padY * 2)
  );
  ctx.clip();
  const maxTextW = Math.max(0, w - padX * 2);
  const t = ellipsizeToWidth(ctx, text, maxTextW);
  ctx.fillText(t, x + padX, yMid);
  ctx.restore();
}
function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
function drawSmallX(ctx, x, y, w, h, color = "#e05555") {
  const pad = Math.max(4, Math.floor(Math.min(w, h) * 0.28));
  const x0 = x + pad;
  const y0 = y + pad;
  const x1 = x + w - pad;
  const y1 = y + h - pad;
  ctx.save();
  ctx.lineCap = "round";
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1.8, Math.min(w, h) * 0.12);
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.moveTo(x1, y0);
  ctx.lineTo(x0, y1);
  ctx.stroke();
  ctx.restore();
}
function drawHoverOverlay(ctx, x, y, w, h, danger = false) {
  if (w <= 2 || h <= 2) return;
  ctx.save();
  ctx.globalAlpha = danger ? 0.10 : 0.08;
  ctx.fillStyle = danger ? "#e05555" : "#ffffff";
  roundRectPath(ctx, x + 1, y + 1, w - 2, h - 2, 6);
  ctx.fill();
  ctx.globalAlpha = danger ? 0.22 : 0.16;
  ctx.strokeStyle = danger ? "#e05555" : "#ffffff";
  ctx.lineWidth = 1;
  roundRectPath(ctx, x + 1, y + 1, w - 2, h - 2, 6);
  ctx.stroke();
  ctx.restore();
}
function drawGripDots(ctx, x, y, w, h, active = false) {
  ctx.save();
  ctx.globalAlpha = active ? 0.92 : 0.72;
  ctx.fillStyle = "#d0d0d0";
  const cols = 2;
  const rows = 3;
  const r = Math.max(1.2, Math.min(w, h) * 0.07);
  const gapX = Math.max(r * 2.2, w * 0.18);
  const gapY = Math.max(r * 2.2, h * 0.14);
  const gridW = gapX * (cols - 1);
  const gridH = gapY * (rows - 1);
  const cx0 = x + w / 2 - gridW / 2;
  const cy0 = y + h / 2 - gridH / 2;
  for (let ry = 0; ry < rows; ry++) {
    for (let cx = 0; cx < cols; cx++) {
      const px = cx0 + cx * gapX;
      const py = cy0 + ry * gapY;
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}
function setCanvasCursor(cursor) {
  try {
    const c = app?.canvas?.canvas;
    if (c) c.style.cursor = cursor || "";
  } catch (_) { }
}
let CSVHoverNode = null;
let CSVDragNode = null;
function isDragging() {
  return !!(CSVDragNode?._CSVDrag?.row && CSVDragNode._CSVDrag.row._dragging);
}
function clearHoverOnNode(node) {
  if (!node) return;
  let changed = false;
  for (const w of (node.widgets || [])) {
    const t = w?.value?.type;
    if ((t === "CsvRowWidget" || t === "ExtraPromptWidget") && w._hover) {
      w._hover = null;
      changed = true;
    }
    if ((t === "CsvRowWidget" || t === "ExtraPromptWidget") && w._dragging) {
      w._dragging = false;
      changed = true;
    }
  }
  if (node._CSVDrag) {
    node._CSVDrag = null;
    changed = true;
  }
  if (changed) node.setDirtyCanvas(true, true);
}
async function uploadPromptFile(file, mode = "auto", rename_to = null) {
  const form = new FormData();
  form.append("file", file);
  form.append("mode", mode);
  if (rename_to) form.append("rename_to", rename_to);
  const res = await api.fetchApi("/CSV/csv_prompt_upload", { method: "POST", body: form });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json?.error || `Upload failed (${res.status})`);
    err.status = res.status;
    err.data = json;
    throw err;
  }
  return json;
}
async function readPromptFile(filename) {
  const res = await api.fetchApi(`/CSV/csv_prompt_read?filename=${encodeURIComponent(filename)}`);
  if (!res.ok) throw new Error(`Read failed (${res.status})`);
  return await res.json();
}
async function listPromptFiles() {
  const res = await api.fetchApi("/CSV/csv_prompt_list");
  if (!res.ok) throw new Error(`List failed (${res.status})`);
  const json = await res.json();
  return Array.isArray(json?.files) ? json.files : [];
}
const _CSVCsvContentCache = new Map();
async function refreshEditedCsv(filename) {
  _CSVCsvContentCache.delete(filename);
  const data = await readPromptFile(filename);
  const validKeys = new Set(["Random", ...(data.labels || [])]);
  const visited = new Set();
  let cleared = 0;
  const refreshGraph = graph => {
    if (!graph || visited.has(graph)) return;
    visited.add(graph);
    for (const node of graph._nodes || []) {
      for (const row of node.widgets || []) {
        if (row?.value?.type !== "CsvRowWidget" || row.value.file !== filename) continue;
        const before = row._getKeysEffective();
        const keys = before.filter(key => validKeys.has(key));
        cleared += before.length - keys.length;
        row._labels = ["(None)", "Random", ...(data.labels || [])];
        row._map = data.map || {};
        row.value.key = keys.length > 1 ? keys.slice() : (keys[0] || "(None)");
        row.value.keys = keys.length > 1 ? keys.slice() : [];
        node.setDirtyCanvas(true, true);
      }
      refreshGraph(node.subgraph);
    }
  };
  refreshGraph(app.graph);
  if (cleared) toast("warn", "CSV 已更新", `已清除 ${cleared} 个已改名或删除的选择，请重新选择。`, 5000);
}
async function openCsvEditor(filename, afterSaved) {
  try { await showCsvEditor(filename, { onSaved: async savedName => {
    await refreshEditedCsv(savedName);
    await afterSaved?.(savedName);
  } }); }
  catch (error) { toast("error", "编辑 CSV", String(error?.message || error), 6000); }
}
function _CSVNorm(s) {
  return String(s ?? "").toLowerCase();
}
function _CSVSplitCommaTokens(s) {
  return String(s ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}
async function _CSVGetFileDataCached(filename) {
  if (_CSVCsvContentCache.has(filename)) return _CSVCsvContentCache.get(filename);
  const data = await readPromptFile(filename);
  const norm = {
    labels: Array.isArray(data?.labels) ? data.labels.map(String) : [],
    map: (data?.map && typeof data.map === "object") ? data.map : {},
  };
  _CSVCsvContentCache.set(filename, norm);
  return norm;
}
async function _CSVFindHitsInFile(filename, needleRaw) {
  const needle = _CSVNorm(needleRaw).trim();
  if (!needle) return [];
  const data = await _CSVGetFileDataCached(filename);
  const hits = [];
  const seen = new Set();
  for (const lab of (data.labels || [])) {
    const t = String(lab ?? "").trim();
    if (!t || t === "(None)" || t === "Random") continue;
    if (_CSVNorm(t).includes(needle)) {
      const key = _CSVNorm(t);
      if (!seen.has(key)) {
        seen.add(key);
        hits.push(t);
      }
    }
  }
  return hits;
}
function showAdditionalPromptModal(currentText = "") {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.style.position = "fixed";
    overlay.style.inset = "0";
    overlay.style.background = "rgba(0,0,0,0.55)";
    overlay.style.zIndex = "999999";
    overlay.style.display = "flex";
    overlay.style.alignItems = "center";
    overlay.style.justifyContent = "center";
    const card = document.createElement("div");
    card.style.width = "720px";
    card.style.maxWidth = "94vw";
    card.style.maxHeight = "86vh";
    card.style.background = "#1f1f1f";
    card.style.border = "1px solid #444";
    card.style.borderRadius = "12px";
    card.style.padding = "14px";
    card.style.color = "#eee";
    card.style.fontFamily = "sans-serif";
    card.style.boxShadow = "0 10px 30px rgba(0,0,0,0.35)";
    card.style.display = "flex";
    card.style.flexDirection = "column";
    card.style.gap = "10px";
    const title = document.createElement("div");
    title.textContent = "Additional Prompt (multiline)";
    title.style.fontSize = "15px";
    title.style.fontWeight = "600";
    const hint = document.createElement("div");
    hint.textContent = "This text will be inserted into the prompt at this row’s position.";
    hint.style.fontSize = "12px";
    hint.style.opacity = "0.8";
    hint.style.lineHeight = "1.35";
    const ta = document.createElement("textarea");
    ta.value = String(currentText ?? "");
    ta.style.width = "100%";
    ta.style.minHeight = "220px";
    ta.style.maxHeight = "52vh";
    ta.style.resize = "vertical";
    ta.style.padding = "10px";
    ta.style.borderRadius = "10px";
    ta.style.border = "1px solid #555";
    ta.style.background = "#2b2b2b";
    ta.style.color = "#eee";
    ta.style.outline = "none";
    ta.style.fontFamily = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
    ta.style.fontSize = "12px";
    ta.style.lineHeight = "1.35";
    const buttons = document.createElement("div");
    buttons.style.display = "flex";
    buttons.style.justifyContent = "flex-end";
    buttons.style.gap = "8px";
    const btn = (label) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.style.padding = "8px 10px";
      b.style.borderRadius = "10px";
      b.style.border = "1px solid #555";
      b.style.background = "#2b2b2b";
      b.style.color = "#eee";
      b.style.cursor = "pointer";
      return b;
    };
    const cancel = btn("Cancel");
    const clear = btn("Clear");
    const save = btn("Save");
    const cleanup = () => document.removeEventListener("keydown", onKeyDown, true);
    const close = (val) => {
      cleanup();
      if (overlay.parentNode) document.body.removeChild(overlay);
      resolve(val);
    };
    cancel.onclick = () => close(null);
    clear.onclick = () => (ta.value = "");
    save.onclick = () => close(ta.value);
    overlay.onclick = (e) => {
      if (e.target === overlay) cancel.onclick();
    };
    const onKeyDown = (e) => {
      if (e.key === "Escape") cancel.onclick();
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        save.onclick();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    card.appendChild(title);
    card.appendChild(hint);
    card.appendChild(ta);
    buttons.appendChild(cancel);
    buttons.appendChild(clear);
    buttons.appendChild(save);
    card.appendChild(buttons);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    setTimeout(() => {
      ta.focus();
      ta.selectionStart = ta.value.length;
      ta.selectionEnd = ta.value.length;
    }, 0);
  });
}
function showConflictModal({ filename, suggested }) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.style.position = "fixed";
    overlay.style.inset = "0";
    overlay.style.background = "rgba(0,0,0,0.55)";
    overlay.style.zIndex = "999999";
    overlay.style.display = "flex";
    overlay.style.alignItems = "center";
    overlay.style.justifyContent = "center";
    const card = document.createElement("div");
    card.style.width = "560px";
    card.style.maxWidth = "92vw";
    card.style.background = "#1f1f1f";
    card.style.border = "1px solid #444";
    card.style.borderRadius = "12px";
    card.style.padding = "14px";
    card.style.color = "#eee";
    card.style.fontFamily = "sans-serif";
    card.style.boxShadow = "0 10px 30px rgba(0,0,0,0.35)";
    const title = document.createElement("div");
    title.textContent = "File already exists";
    title.style.fontSize = "16px";
    title.style.fontWeight = "600";
    title.style.marginBottom = "8px";
    const msg = document.createElement("div");
    msg.style.fontSize = "13px";
    msg.style.lineHeight = "1.35";
    msg.style.opacity = "0.95";
    msg.innerHTML =
      `<div>A file named <b>${filename}</b> already exists in <code>input/csv</code> with different content.</div>` +
      `<div style="margin-top:8px">Choose what to do:</div>`;
    const inputWrap = document.createElement("div");
    inputWrap.style.marginTop = "10px";
    inputWrap.style.display = "flex";
    inputWrap.style.flexDirection = "column";
    inputWrap.style.gap = "6px";
    const label = document.createElement("div");
    label.textContent = "Rename to:";
    label.style.fontSize = "12px";
    label.style.opacity = "0.85";
    const input = document.createElement("input");
    input.type = "text";
    input.value = suggested || filename;
    input.style.padding = "10px";
    input.style.borderRadius = "10px";
    input.style.border = "1px solid #555";
    input.style.background = "#2b2b2b";
    input.style.color = "#eee";
    input.style.outline = "none";
    inputWrap.appendChild(label);
    inputWrap.appendChild(input);
    const buttons = document.createElement("div");
    buttons.style.display = "flex";
    buttons.style.gap = "8px";
    buttons.style.justifyContent = "flex-end";
    buttons.style.marginTop = "14px";
    function makeBtn(labelText) {
      const b = document.createElement("button");
      b.textContent = labelText;
      b.style.padding = "8px 10px";
      b.style.borderRadius = "10px";
      b.style.border = "1px solid #555";
      b.style.background = "#2b2b2b";
      b.style.color = "#eee";
      b.style.cursor = "pointer";
      return b;
    }
    const cancel = makeBtn("Cancel");
    const rename = makeBtn("Rename");
    const overwrite = makeBtn("Overwrite");
    function close(result) {
      document.body.removeChild(overlay);
      resolve(result);
    }
    cancel.onclick = () => close({ action: "cancel" });
    overwrite.onclick = () => close({ action: "overwrite" });
    rename.onclick = () => close({ action: "rename", rename_to: input.value });
    overlay.onclick = (e) => {
      if (e.target === overlay) cancel.onclick();
    };
    card.appendChild(title);
    card.appendChild(msg);
    card.appendChild(inputWrap);
    buttons.appendChild(cancel);
    buttons.appendChild(rename);
    buttons.appendChild(overwrite);
    card.appendChild(buttons);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
  });
}
function showFilePickerModal(allFiles, nodeExistingFiles = [], activeFile = null, defaultMulti = false) {
  return new Promise((resolve) => {
    const multiSelected = new Set(nodeExistingFiles);
    let isMulti = defaultMulti;
    let inContentsMode = false;
    const expandedFolders = new Set();
    const filesToExpand = new Set([...nodeExistingFiles]);
    if (activeFile) filesToExpand.add(activeFile);
    for (const f of filesToExpand) {
      if (!f) continue;
      const parts = f.split('/');
      parts.pop();
      let pathAccumulator = "";
      for (const folder of parts) {
        pathAccumulator = pathAccumulator ? `${pathAccumulator}/${folder}` : folder;
        expandedFolders.add(pathAccumulator);
      }
    }
    function buildFileTree(files) {
      const root = { folders: {}, files: [] };
      for (const f of files) {
        const parts = f.split('/');
        const fileName = parts.pop();
        let current = root;
        let pathAccumulator = "";
        for (const folder of parts) {
          pathAccumulator = pathAccumulator ? `${pathAccumulator}/${folder}` : folder;
          if (!current.folders[folder]) {
            current.folders[folder] = {
              name: folder,
              fullPath: pathAccumulator,
              folders: {},
              files: []
            };
          }
          current = current.folders[folder];
        }
        current.files.push({ name: fileName, fullPath: f });
      }
      return root;
    }
    function sortTree(node) {
      const folderKeys = Object.keys(node.folders).sort((a, b) => a.localeCompare(b));
      const sortedFolders = folderKeys.map(k => {
        sortTree(node.folders[k]);
        return node.folders[k];
      });
      node.files.sort((a, b) => a.name.localeCompare(b.name));
      return { folders: sortedFolders, files: node.files };
    }
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.65);z-index:999999;display:flex;align-items:center;justify-content:center;";
    const card = document.createElement("div");
    card.style.cssText = "width:720px;max-width:94vw;max-height:86vh;background:#1f1f1f;border:1px solid #444;border-radius:12px;padding:14px;color:#eee;font-family:sans-serif;box-shadow:0 10px 30px rgba(0,0,0,0.35);display:flex;flex-direction:column;gap:10px;";
    const title = document.createElement("div");
    title.innerHTML = `Select CSV File <span style="font-weight:400;opacity:0.6;font-size:0.85em;margin-left:8px;">(Root: input/csv)</span>`;
    title.style.cssText = "font-size:15px;font-weight:600;";
    const toolBar = document.createElement("div");
    toolBar.style.cssText = "display:flex;gap:8px;align-items:stretch;";
    const searchInput = document.createElement("input");
    searchInput.type = "text";
    searchInput.placeholder = "Search filenames...";
    searchInput.style.cssText = "flex:1;height:38px;padding:0 10px;border-radius:8px;border:1px solid #555;background:#2b2b2b;color:#eee;outline:none;";
    const contentBtn = document.createElement("button");
    contentBtn.textContent = "In Contents?";
    contentBtn.title = "Search inside CSV contents (Keys only)";
    contentBtn.style.cssText = "padding:0 12px;border-radius:8px;border:1px solid #555;background:#2b2b2b;color:#eee;cursor:pointer;font-size:12px;white-space:nowrap;";
    const multiBtn = document.createElement("button");
    multiBtn.style.cssText = "width:38px;height:38px;border-radius:8px;border:1px solid #555;background:#2b2b2b;color:#eee;cursor:pointer;display:grid;place-items:center;padding:0;font-size:16px;";
    function updateMultiVisual() {
      if (isMulti) {
        multiBtn.textContent = "✓";
        multiBtn.title = "Multi-select ON";
        multiBtn.style.background = "#1f3a25";
        multiBtn.style.borderColor = "#2d7a40";
      } else {
        multiBtn.textContent = "⧉";
        multiBtn.title = "Single-select (Replace)";
        multiBtn.style.background = "#2b2b2b";
        multiBtn.style.borderColor = "#555";
      }
    }
    updateMultiVisual();
    multiBtn.onclick = () => { isMulti = !isMulti; updateMultiVisual(); renderList(); };
    contentBtn.onclick = () => {
      inContentsMode = !inContentsMode;
      if (inContentsMode) {
        contentBtn.style.background = "#1f3a25";
        contentBtn.style.borderColor = "#2d7a40";
        searchInput.placeholder = "Search content (Keys)...";
      } else {
        contentBtn.style.background = "#2b2b2b";
        contentBtn.style.borderColor = "#555";
        searchInput.placeholder = "Search filenames...";
      }
      renderList();
    };
    toolBar.append(searchInput, contentBtn, multiBtn);
    const listContainer = document.createElement("div");
    listContainer.style.cssText = "flex:1;overflow-y:auto;border:1px solid #333;border-radius:8px;background:#181818;min-height:240px;";
    const footer = document.createElement("div");
    footer.style.cssText = "display:flex;justify-content:flex-end;gap:8px;padding-top:4px;";
    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "Cancel";
    cancelBtn.style.cssText = "padding:8px 14px;border-radius:8px;border:1px solid #555;background:#2b2b2b;color:#eee;cursor:pointer;";
    const applyBtn = document.createElement("button");
    applyBtn.textContent = "Apply";
    applyBtn.style.cssText = "padding:8px 14px;border-radius:8px;border:1px solid #2d7a40;background:#1f3a25;color:#eee;cursor:pointer;font-weight:600;";
    function createRow(text, fullPath, isFolder, depth, isMatch = false, subText = "") {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;align-items:center;padding:6px 12px;border-bottom:1px solid #222;cursor:pointer;user-select:none;";
      row.style.paddingLeft = `${12 + depth * 20}px`;
      const isActiveRowFile = (fullPath === activeFile);
      const isMultiSelected = isMulti && multiSelected.has(fullPath);
      const isUsedInNode = nodeExistingFiles.includes(fullPath);
      if (isActiveRowFile && !isFolder) {
        row.style.background = "rgba(70, 130, 180, 0.25)";
        row.style.borderLeft = "3px solid #4a90e2";
        row.style.paddingLeft = `${9 + depth * 20}px`;
      } else if (isMultiSelected && !isFolder) {
        row.style.background = "#242e25";
      }
      const iconArea = document.createElement("div");
      iconArea.style.cssText = "width:20px;height:20px;margin-right:8px;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:12px;color:#888;";
      if (isFolder) {
        const isExpanded = expandedFolders.has(fullPath);
        iconArea.textContent = isExpanded ? "▼" : "▶";
        iconArea.style.fontSize = "10px";
        row.style.background = "#1a1a1a";
        row.style.color = "#ccc";
      } else {
        const showCheck = isMulti ? isMultiSelected : isUsedInNode;
        iconArea.style.border = showCheck ? "1px solid #4caf50" : "1px solid #555";
        iconArea.style.borderRadius = "4px";
        iconArea.style.background = showCheck ? "rgba(76, 175, 80, 0.2)" : "transparent";
        iconArea.textContent = showCheck ? "✓" : "";
        iconArea.style.color = showCheck ? "#4caf50" : "transparent";
      }
      const textCol = document.createElement("div");
      textCol.style.cssText = "flex:1;overflow:hidden;";
      const mainText = document.createElement("div");
      mainText.textContent = text;
      mainText.style.cssText = "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#eee;";
      if (isFolder) mainText.style.fontWeight = "600";
      if (isActiveRowFile) mainText.style.fontWeight = "700";
      textCol.appendChild(mainText);
      if (subText) {
        const sub = document.createElement("div");
        sub.textContent = subText;
        sub.style.cssText = "font-size:11px;color:#888;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
        textCol.appendChild(sub);
      }
      row.appendChild(iconArea);
      row.appendChild(textCol);
      if (!isFolder) {
        const editButton = document.createElement("button");
        editButton.textContent = "✎ 编辑";
        editButton.title = `编辑 ${fullPath}`;
        editButton.style.cssText = "flex-shrink:0;margin-left:10px;padding:4px 8px;border:1px solid #555;border-radius:5px;background:#303036;color:#ddd;cursor:pointer;";
        editButton.onclick = async event => {
          event.preventDefault(); event.stopPropagation();
          await openCsvEditor(fullPath, savedName => {
            if (!allFiles.includes(savedName)) allFiles.push(savedName);
            renderList();
          });
        };
        row.appendChild(editButton);
      }
      row.onmouseenter = () => { if (!isActiveRowFile && !isMultiSelected) row.style.backgroundColor = "#2a2a2a"; };
      row.onmouseleave = () => {
        if (!isActiveRowFile && !isMultiSelected) row.style.backgroundColor = isFolder ? "#1a1a1a" : "transparent";
        if (isActiveRowFile) row.style.backgroundColor = "rgba(70, 130, 180, 0.25)";
        if (isMultiSelected && !isActiveRowFile) row.style.backgroundColor = "#242e25";
      };
      row.onclick = (e) => {
        e.preventDefault(); e.stopPropagation();
        if (isFolder) {
          if (expandedFolders.has(fullPath)) expandedFolders.delete(fullPath);
          else expandedFolders.add(fullPath);
          renderList();
          return;
        }
        if (isMulti) {
          if (multiSelected.has(fullPath)) {
            multiSelected.delete(fullPath);
          } else {
            multiSelected.add(fullPath);
          }
          renderList();
        } else {
          document.body.removeChild(overlay);
          resolve({ mode: 'single', files: [fullPath] });
        }
      };
      return row;
    }
    function renderTree(container, node, depth) {
      const sorted = sortTree(node);
      for (const folder of sorted.folders) {
        container.appendChild(createRow(folder.name, folder.fullPath, true, depth));
        if (expandedFolders.has(folder.fullPath)) {
          renderTree(container, folder, depth + 1);
        }
      }
      for (const file of sorted.files) {
        container.appendChild(createRow(file.name, file.fullPath, false, depth));
      }
    }
    let renderSeq = 0;
    async function renderList() {
      const mySeq = ++renderSeq;
      const qRaw = searchInput.value.trim();
      const q = qRaw.toLowerCase();
      listContainer.innerHTML = "";
      if (inContentsMode && qRaw) {
        const loading = document.createElement("div");
        loading.textContent = "Searching keys in all files...";
        loading.style.cssText = "padding:20px;text-align:center;color:#aaa;opacity:0.6;";
        listContainer.appendChild(loading);
        const results = [];
        for (const fn of allFiles) {
          if (mySeq !== renderSeq) return;
          try {
            const hits = await _CSVFindHitsInFile(fn, qRaw);
            if (hits && hits.length) results.push({ fn, hits });
          } catch (e) {
            console.error(e);
          }
        }
        if (mySeq !== renderSeq) return;
        listContainer.innerHTML = "";
        if (!results.length) {
          const empty = document.createElement("div");
          empty.textContent = "No matching keys found.";
          empty.style.cssText = "padding:20px;text-align:center;color:#aaa;opacity:0.6;";
          listContainer.appendChild(empty);
          return;
        }
        for (const r of results) {
          const sub = r.hits.slice(0, 3).join(", ") + (r.hits.length > 3 ? "..." : "");
          const row = createRow(r.fn, r.fn, false, 0, true, sub);
          listContainer.appendChild(row);
        }
        return;
      }
      if (!inContentsMode && qRaw) {
        const filtered = allFiles.filter(f => f.toLowerCase().includes(q));
        if (filtered.length === 0) {
           const empty = document.createElement("div");
           empty.textContent = "No matching filenames.";
           empty.style.cssText = "padding:20px;text-align:center;color:#aaa;opacity:0.6;";
           listContainer.appendChild(empty);
        } else {
           filtered.forEach(fn => {
             listContainer.appendChild(createRow(fn, fn, false, 0, true));
           });
        }
        return;
      }
      const root = buildFileTree(allFiles);
      renderTree(listContainer, root, 0);
    }
    let debounceTimer;
    searchInput.oninput = () => {
      clearTimeout(debounceTimer);
      const delay = inContentsMode ? 400 : 200;
      debounceTimer = setTimeout(renderList, delay);
    };
    cancelBtn.onclick = () => { document.body.removeChild(overlay); resolve(null); };
    applyBtn.onclick = () => {
      document.body.removeChild(overlay);
      resolve({ mode: 'multi', files: Array.from(multiSelected) });
    };
    footer.append(cancelBtn, applyBtn);
    card.append(title, toolBar, listContainer, footer);
    overlay.append(card);
    document.body.append(overlay);
    renderList();
    setTimeout(() => searchInput.focus(), 0);
  });
}
function showActiveRowsSearchModal(rows) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.65);z-index:999999;display:flex;align-items:center;justify-content:center;";
    const card = document.createElement("div");
    card.style.cssText = "width:680px;max-width:94vw;max-height:84vh;background:#1f1f1f;border:1px solid #444;border-radius:12px;padding:14px;color:#eee;font-family:sans-serif;box-shadow:0 10px 30px rgba(0,0,0,0.35);display:flex;flex-direction:column;gap:10px;";
    const title = document.createElement("div"); title.textContent = "Search in Added Files"; title.style.fontWeight = "600";
    const search = document.createElement("input");
    search.type = "text"; search.placeholder = "Type to search content...";
    search.style.cssText = "padding:10px;border-radius:10px;border:1px solid #555;background:#2b2b2b;color:#eee;outline:none;";
    const list = document.createElement("div");
    list.style.cssText = "flex:1;overflow-y:auto;border:1px solid #333;border-radius:10px;background:#181818;min-height:200px;";
    const footer = document.createElement("div");
    footer.style.cssText = "display:flex;justify-content:space-between;gap:8px;align-items:center;padding-top:4px;";
    const leftActions = document.createElement("div");
    leftActions.style.cssText = "display:flex;gap:8px;";
    const btnStyle = "padding:8px 14px;border-radius:10px;border:1px solid #555;cursor:pointer;font-size:12px;";
    const clearAllBtn = document.createElement("button");
    clearAllBtn.textContent = "Clear All";
    clearAllBtn.style.cssText = btnStyle + "background:#2b2b2b;color:#e05555;border-color:#552b2b;";
   
    const randomAllBtn = document.createElement("button");
    randomAllBtn.textContent = "Global Random";
    randomAllBtn.style.cssText = btnStyle + "background:#1f283a;color:#85a3e0;border-color:#2d3a50;";
    leftActions.append(randomAllBtn, clearAllBtn);
    const rightActions = document.createElement("div");
    rightActions.style.cssText = "display:flex;gap:8px;";
    const cancelBtn = document.createElement("button"); cancelBtn.textContent = "Cancel";
    cancelBtn.style.cssText = btnStyle + "background:#2b2b2b;color:#eee;";
   
    const applyBtn = document.createElement("button"); applyBtn.textContent = "Apply Changes";
    applyBtn.style.cssText = btnStyle + "border:1px solid #2d7a40;background:#1f3a25;color:#eee;font-weight:600;";
    rightActions.append(cancelBtn, applyBtn);
    footer.append(leftActions, rightActions);
    const pendingSelections = new Map();
    for (const r of rows) {
      if (!r.value.file) continue;
      const keys = new Set();
      const existing = r._getKeysEffective ? r._getKeysEffective() : [];
      existing.forEach(k => keys.add(k));
      if (keys.size > 0) pendingSelections.set(r.value.file, keys);
    }
    function toggleSelection(file, key) {
      if (!pendingSelections.has(file)) pendingSelections.set(file, new Set());
      const set = pendingSelections.get(file);
      if (set.has(key)) {
        set.delete(key);
      } else {
        if (key === "Random") {
           set.clear();
        } else {
           if (set.has("Random")) set.delete("Random");
           if (set.has("(None)")) set.delete("(None)");
        }
        set.add(key);
      }
      renderResults(search.value);
    }
    clearAllBtn.onclick = () => {
        const uniqueFiles = new Set(rows.map(r => r.value.file).filter(Boolean));
        pendingSelections.clear();
        for (const f of uniqueFiles) {
            pendingSelections.set(f, new Set());
        }
       
        renderResults(search.value);
    };
    randomAllBtn.onclick = () => {
        const uniqueFiles = new Set(rows.map(r => r.value.file).filter(Boolean));
        for (const f of uniqueFiles) {
            pendingSelections.set(f, new Set(["Random"]));
        }
        renderResults(search.value);
    };
   
    async function renderItems(itemsByFile) {
        list.innerHTML = "";
        if (itemsByFile.length === 0) {
            list.innerHTML = '<div style="padding:20px;text-align:center;opacity:0.5;color:#aaa;">No items found.</div>';
            return;
        }
        for (const group of itemsByFile) {
            const header = document.createElement("div");
            header.textContent = group.fn;
            header.style.cssText = "padding:8px 12px;background:#252525;border-bottom:1px solid #333;font-weight:600;font-size:13px;color:#ccc;";
            list.appendChild(header);
            const cachedData = await _CSVGetFileDataCached(group.fn);
            const map = cachedData.map || {};
            for (const key of group.keys) {
                const rowEl = document.createElement("div");
                rowEl.style.cssText = "display:flex;align-items:center;padding:8px 12px 8px 24px;border-bottom:1px solid #222;cursor:pointer;";
               
                const isSelected = pendingSelections.has(group.fn) && pendingSelections.get(group.fn).has(key);
               
                const check = document.createElement("div");
                check.textContent = isSelected ? "✓" : "";
                check.style.cssText = `width:18px;height:18px;border:${isSelected ? "1px solid #4caf50" : "1px solid #555"};border-radius:4px;margin-right:10px;background:${isSelected ? "#4caf50" : "transparent"};display:flex;align-items:center;justify-content:center;font-size:12px;color:#fff;`;
               
                const contentDiv = document.createElement("div");
                contentDiv.style.cssText = "overflow:hidden;flex:1;";
                contentDiv.innerHTML = `<div style="color:#ddd;font-size:13px;">${key}</div><div style="color:#888;font-size:11px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${map[key] || ""}</div>`;
               
                rowEl.append(check, contentDiv);
               
                rowEl.onclick = (e) => {
                    e.preventDefault(); e.stopPropagation();
                    toggleSelection(group.fn, key);
                };
                rowEl.onmouseenter = () => rowEl.style.background = "#2a2a2a";
                rowEl.onmouseleave = () => rowEl.style.background = "transparent";
                list.appendChild(rowEl);
            }
        }
    }
    let searchSeq = 0;
    async function renderResults(queryRaw) {
      const seq = ++searchSeq;
      const q = (queryRaw || "").trim().toLowerCase();
     
      if (!q) {
        const selectedGroups = [];
        for (const [fn, keys] of pendingSelections.entries()) {
            if (keys.size > 0) {
                selectedGroups.push({ fn, keys: Array.from(keys) });
            }
        }
        selectedGroups.sort((a,b) => a.fn.localeCompare(b.fn));
       
        if (seq !== searchSeq) return;
        if (selectedGroups.length === 0) {
            list.innerHTML = '<div style="padding:20px;text-align:center;opacity:0.5;color:#aaa;">No items currently selected.<br>Type to search content...</div>';
        } else {
            const viewHeader = document.createElement("div");
            viewHeader.textContent = "Currently Selected Items (Clear search to view):";
            viewHeader.style.cssText = "padding:10px;color:#888;font-size:12px;font-style:italic;background:#1a1a1a;";
            list.innerHTML = "";
            list.appendChild(viewHeader);
            await renderItems(selectedGroups);
            list.prepend(viewHeader);
        }
        return;
      }
     
      list.innerHTML = '<div style="padding:20px;text-align:center;opacity:0.5;color:#aaa;">Searching...</div>';
      const uniqueFiles = [...new Set(rows.map(r => r.value.file).filter(Boolean))];
      const results = [];
      for (const fn of uniqueFiles) {
        if (seq !== searchSeq) return;
        try {
          const hits = await _CSVFindHitsInFile(fn, q);
          if (hits.length) results.push({ fn, keys: hits });
        } catch (_) {}
      }
      if (seq !== searchSeq) return;
      await renderItems(results);
    }
    let debounceT;
    search.oninput = () => { clearTimeout(debounceT); debounceT = setTimeout(() => renderResults(search.value), 300); };
    cancelBtn.onclick = () => { document.body.removeChild(overlay); resolve(null); };
    applyBtn.onclick = () => { document.body.removeChild(overlay); resolve(pendingSelections); };
    card.append(title, search, list, footer); overlay.append(card); document.body.append(overlay);
    search.focus(); renderResults("");
  });
}
function showKeyPickerMenu(items, event, titleText = "Selection", opts = {}) {
  return new Promise((resolve) => {
    const ev = event?.originalEvent || event?.detail?.event || event;
    const cx = typeof ev?.clientX === "number" ? ev.clientX : 0;
    const cy = typeof ev?.clientY === "number" ? ev.clientY : 0;
    const initialSelected = Array.isArray(opts?.selected) ? opts.selected.map(String) : [];
    let multiMode = false;
    const selected = new Set(initialSelected);
    selected.delete("(None)");
    const overlay = document.createElement("div");
    overlay.style.position = "fixed";
    overlay.style.inset = "0";
    overlay.style.background = "transparent";
    overlay.style.zIndex = "1000000";
    const card = document.createElement("div");
    card.style.position = "absolute";
    card.style.left = "0px";
    card.style.top = "0px";
    card.style.width = "340px";
    card.style.maxWidth = "86vw";
    card.style.background = "#1f1f1f";
    card.style.border = "1px solid #444";
    card.style.borderRadius = "12px";
    card.style.padding = "10px";
    card.style.color = "#eee";
    card.style.fontFamily = "sans-serif";
    card.style.boxShadow = "0 10px 30px rgba(0,0,0,0.35)";
    card.style.display = "flex";
    card.style.flexDirection = "column";
    card.style.gap = "8px";
    const title = document.createElement("div");
    title.textContent = titleText;
    title.style.fontSize = "13px";
    title.style.fontWeight = "600";
    title.style.opacity = "0.95";
    const filterRow = document.createElement("div");
    filterRow.style.display = "flex";
    filterRow.style.gap = "8px";
    filterRow.style.alignItems = "center";
    const search = document.createElement("input");
    search.type = "text";
    search.placeholder = "Filter";
    search.style.flex = "1";
    search.style.padding = "9px 10px";
    search.style.borderRadius = "10px";
    search.style.border = "1px solid #555";
    search.style.background = "#2b2b2b";
    search.style.color = "#eee";
    search.style.outline = "none";
    const modeBtn = document.createElement("button");
    modeBtn.style.width = "36px";
    modeBtn.style.height = "36px";
    modeBtn.style.borderRadius = "10px";
    modeBtn.style.border = "1px solid #555";
    modeBtn.style.background = "#2b2b2b";
    modeBtn.style.color = "#eee";
    modeBtn.style.cursor = "pointer";
    modeBtn.style.display = "grid";
    modeBtn.style.placeItems = "center";
    modeBtn.style.padding = "0";
    function setModeButtonVisual() {
      if (!multiMode) {
        modeBtn.style.background = "#2b2b2b";
        modeBtn.style.borderColor = "#555";
        modeBtn.textContent = "⧉";
        modeBtn.title = "Enable multi-select";
      } else {
        modeBtn.style.background = "#1f3a25";
        modeBtn.style.borderColor = "#2d7a40";
        modeBtn.textContent = "✓";
        modeBtn.title = "Confirm selection";
      }
    }
    setModeButtonVisual();
    modeBtn.onclick = (e) => {
      e.preventDefault?.();
      e.stopPropagation?.();
      if (!multiMode) {
        multiMode = true;
        selected.delete("(None)");
        setModeButtonVisual();
        render(search.value);
        return;
      }
      const chosen = Array.from(selected)
        .map(String)
        .filter((s) => s && s !== "(None)");
      cleanup();
      if (overlay.parentNode) document.body.removeChild(overlay);
      if (chosen.length === 0) {
        resolve({ mode: "clear" });
        return;
      }
      if (chosen.length === 1) {
        const one = chosen[0];
        const pickedItem = (items || []).find((it) => String(it?.content ?? "") === one) || { content: one };
        resolve({ mode: "single", picked: pickedItem });
        return;
      }
      resolve({ mode: "multi", selected: chosen });
    };
    filterRow.appendChild(search);
    filterRow.appendChild(modeBtn);
    const clearWrap = document.createElement("div");
    clearWrap.style.marginTop = "2px";
    clearWrap.style.marginBottom = "6px";
    const clearBtnRow = document.createElement("div");
    clearBtnRow.style.display = "flex";
    clearBtnRow.style.alignItems = "center";
    clearBtnRow.style.gap = "8px";
    clearBtnRow.style.padding = "9px 10px";
    clearBtnRow.style.border = "1px solid #333";
    clearBtnRow.style.borderRadius = "10px";
    clearBtnRow.style.background = "#151515";
    clearBtnRow.style.cursor = "pointer";
    clearBtnRow.style.userSelect = "none";
    const clearLabel = document.createElement("div");
    clearLabel.textContent = "Clear";
    clearLabel.style.flex = "1";
    clearLabel.style.opacity = "0.95";
    const clearMark = document.createElement("div");
    clearMark.style.width = "18px";
    clearMark.style.minWidth = "18px";
    clearMark.style.textAlign = "center";
    clearMark.style.opacity = "0.9";
    clearBtnRow.onmouseenter = () => (clearBtnRow.style.background = "#1f1f1f");
    clearBtnRow.onmouseleave = () => (clearBtnRow.style.background = "#151515");
    clearBtnRow.onclick = (e) => {
      e.preventDefault?.();
      e.stopPropagation?.();
      if (selected.size === 0) return;
      selected.clear();
      if (!multiMode) {
        cleanup();
        if (overlay.parentNode) document.body.removeChild(overlay);
        resolve({ mode: "clear" });
        return;
      }
      render(search.value);
    };
    clearBtnRow.appendChild(clearLabel);
    clearBtnRow.appendChild(clearMark);
    clearWrap.appendChild(clearBtnRow);
    const list = document.createElement("div");
    list.style.maxHeight = "320px";
    list.style.overflow = "auto";
    list.style.border = "1px solid #333";
    list.style.borderRadius = "10px";
    list.style.background = "#181818";
    const close = () => {
      cleanup();
      if (overlay.parentNode) document.body.removeChild(overlay);
      resolve(null);
    };
    overlay.onclick = (e) => {
      if (e.target === overlay) close();
    };
    const onKeyDown = (e) => {
      if (e.key === "Escape") close();
      if (multiMode && (e.key === "Enter" || e.key === "Return")) {
        modeBtn.onclick(e);
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    const cleanup = () => {
      document.removeEventListener("keydown", onKeyDown, true);
    };
    function render(filterText) {
      clearMark.textContent = selected.size ? "↺" : "";
      clearBtnRow.style.opacity = selected.size ? "1" : "0.55";
      clearBtnRow.style.cursor = selected.size ? "pointer" : "default";
      list.innerHTML = "";
      const f = (filterText || "").trim().toLowerCase();
      const shown = (items || []).filter((it) => {
        const t = String(it?.content ?? "");
        if (multiMode && t === "(None)") return false;
        return !f || t.toLowerCase().includes(f);
      });
      if (!shown.length) {
        const empty = document.createElement("div");
        empty.textContent = "No matches.";
        empty.style.padding = "10px";
        empty.style.opacity = "0.8";
        list.appendChild(empty);
        return;
      }
      for (const it of shown) {
        const content = String(it?.content ?? "");
        const row = document.createElement("div");
        row.style.display = "flex";
        row.style.alignItems = "center";
        row.style.gap = "8px";
        row.style.padding = "9px 10px";
        row.style.cursor = "pointer";
        row.style.borderBottom = "1px solid #222";
        row.style.whiteSpace = "nowrap";
        row.style.overflow = "hidden";
        const label = document.createElement("div");
        label.textContent = content;
        label.style.flex = "1";
        label.style.overflow = "hidden";
        label.style.textOverflow = "ellipsis";
        const mark = document.createElement("div");
        mark.style.width = "18px";
        mark.style.minWidth = "18px";
        mark.style.textAlign = "center";
        mark.style.opacity = "0.95";
        const isSel = selected.has(content);
        mark.textContent = isSel ? "✓" : "";
        row.style.background = isSel ? "#242e25" : "transparent";
        row.onmouseenter = () => {
          row.style.background = isSel ? "#283328" : "#232323";
        };
        row.onmouseleave = () => {
          const nowSel = selected.has(content);
          row.style.background = nowSel ? "#242e25" : "transparent";
        };
        row.onclick = (e) => {
          e.preventDefault?.();
          e.stopPropagation?.();
          if (!multiMode) {
            cleanup();
            if (overlay.parentNode) document.body.removeChild(overlay);
            resolve({ mode: "single", picked: it });
            return;
          }
          if (selected.has(content)) selected.delete(content);
          else selected.add(content);
          render(search.value);
        };
        row.appendChild(label);
        row.appendChild(mark);
        list.appendChild(row);
      }
    }
    search.oninput = () => render(search.value);
    card.appendChild(title);
    card.appendChild(filterRow);
    card.appendChild(clearWrap);
    card.appendChild(list);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    render("");
    const pad = 8;
    const vw = window.innerWidth || 0;
    const vh = window.innerHeight || 0;
    const rect = card.getBoundingClientRect();
    let left = cx;
    let top = cy;
    if (left + rect.width + pad > vw) left = Math.max(pad, vw - rect.width - pad);
    if (top + rect.height + pad > vh) top = Math.max(pad, vh - rect.height - pad);
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
    setTimeout(() => {
      search.focus();
      search.select();
    }, 0);
  });
}
function pickFilesFromDialog() {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = ".csv,text/csv";
    input.onchange = () => resolve(Array.from(input.files || []));
    input.click();
  });
}
async function uploadWithConflictResolution(file) {
  let up;
  let overwriteWasChosen = false;
  try {
    up = await uploadPromptFile(file, "auto");
  } catch (e) {
    if (e?.status === 409 && e?.data?.error === "NAME_CONFLICT") {
      const choice = await showConflictModal({
        filename: e.data.filename,
        suggested: e.data.suggested,
      });
      if (choice.action === "cancel") return { cancelled: true };
      if (choice.action === "overwrite") {
        overwriteWasChosen = true;
        up = await uploadPromptFile(file, "overwrite");
      } else if (choice.action === "rename") {
        up = await uploadPromptFile(file, "rename", choice.rename_to);
      } else {
        return { cancelled: true };
      }
    } else {
      throw e;
    }
  }
  return { cancelled: false, overwriteWasChosen, up };
}
function getRowWidgets(node) {
  return (node.widgets || []).filter((w) => {
    const t = w?.value?.type;
    return t === "CsvRowWidget" || t === "ExtraPromptWidget";
  });
}
function isRowWidget(w) {
  const t = w?.value?.type;
  return t === "CsvRowWidget" || t === "ExtraPromptWidget";
}
function hasRowForFilename(node, filename, excludeWidget = null) {
  return (node.widgets || []).some((w) => {
    if (w === excludeWidget) return false;
    if (w?.value?.type !== "CsvRowWidget") return false;
    return w?.value?.file === filename;
  });
}
function removeRowsForFilename(node, filename) {
  const rows = (node.widgets || []).filter((w) => w?.value?.type === "CsvRowWidget");
  for (const row of rows) {
    if (row?.value?.file === filename) {
      const idx = node.widgets.indexOf(row);
      if (idx !== -1) node.widgets.splice(idx, 1);
    }
  }
}
function recomputeNodeSize(node) {
  try {
    const computed = node.computeSize?.();
    if (computed && node.size) {
      node.size[0] = Math.max(node.size[0], computed[0]);
      node.size[1] = Math.max(80, computed[1]);
    }
  } catch (_) { }
}
const LIST_TOP_SPACER_ID = "CSV_list_top_spacer";
const BUTTON_SPACER_ID = "CSV_select_csv_spacer";
const BUTTON_ID = "CSV_select_csv_button";
const BUTTON_LABEL = "Select CSV File";
const GLOBAL_SEARCH_BUTTON_ID = "CSV_global_search_button";
const GLOBAL_SEARCH_BUTTON_LABEL = "🔍 Search in Added Files";
const EXTRA_PROMPT_ID = "CSV_extra_prompt_row";
const EXTRA_PROMPT_NAME = "csv_additional_prompt";
const LIST_SIDE_MARGIN = (globalThis?.LiteGraph?.NODE_WIDGET_MARGIN ?? 10);
const ROW_HEIGHT = 54;
const DRAG_SNAP_FRACTION = 0.50;
const DRAG_SNAP_ENTER = 0.15;
const DRAG_SNAP_EXIT = 0.65;
const DRAG_HANDLE_W = 22;
const DRAG_HANDLE_GAP = 8;
function isListTopSpacer(w) { return w?._CSV_id === LIST_TOP_SPACER_ID; }
function isButtonSpacer(w) { return w?._CSV_id === BUTTON_SPACER_ID; }
function isBottomButton(w) { return w?._CSV_id === BUTTON_ID; }
function isExtraPromptRow(w) { return w?._CSV_id === EXTRA_PROMPT_ID; }
function updateRowOrders(node) {
  const rows = getRowWidgets(node);
  for (let i = 0; i < rows.length; i++) {
    if (rows[i]?.value && typeof rows[i].value === "object") {
      rows[i].value.order = i;
    }
  }
}
function ensureListTopSpacer(node, height = 10) {
  const existing = (node.widgets || []).find(isListTopSpacer);
  if (existing) return existing;
  const spacer = {
    type: "custom",
    name: " ",
    _CSV_id: LIST_TOP_SPACER_ID,
    value: { type: "CSVListTopSpacer" },
    serialize: false,
    serializeValue() { return undefined; },
    computeSize() { return [0, height]; },
    draw() { },
  };
  node.addCustomWidget(spacer);
  return spacer;
}
function ensureButtonSpacer(node, height = 10) {
  const existing = (node.widgets || []).find(isButtonSpacer);
  if (existing) return existing;
  const spacer = {
    type: "custom",
    name: " ",
    _CSV_id: BUTTON_SPACER_ID,
    value: { type: "CSVButtonSpacer" },
    serialize: false,
    serializeValue() { return undefined; },
    computeSize() { return [0, height]; },
    draw() { },
  };
  node.addCustomWidget(spacer);
  return spacer;
}
function layoutWidgets(node) {
  const widgets = node.widgets || [];
  const rows = widgets.filter(isRowWidget);
  const topSpacer = widgets.find(isListTopSpacer) || null;
  const btnSpacer = widgets.find(isButtonSpacer) || null;
  const searchBtn = widgets.find(isGlobalSearchButton);
  const btn = widgets.find(isBottomButton) || null;
  const rest = widgets.filter((w) => {
    if (isRowWidget(w)) return false;
    if (w === topSpacer) return false;
    if (w === btnSpacer) return false;
    if (w === btn) return false;
    if (w === searchBtn) return false; // Fix: Prevent duplication
    if (isListTopSpacer(w)) return false;
    if (isButtonSpacer(w)) return false;
    if (isBottomButton(w)) return false;
    if (isGlobalSearchButton(w)) return false; // Fix: Prevent duplication
    return true;
  });
  const next = [...rest]; // ExtraPrompt (and others) go here
  if (searchBtn) next.push(searchBtn); // Fix: Place Search button below ExtraPrompt
  if (topSpacer) next.push(topSpacer); // Then the spacer
  next.push(...rows); // Then the CSV rows
  if (btnSpacer) next.push(btnSpacer); // Then bottom spacer
  if (btn) next.push(btn); // Fix: Select CSV button stays at the very bottom
  node.widgets = next;
  updateRowOrders(node);
}
function removeAllCSVUiWidgets(node) {
  node.widgets = (node.widgets || []).filter((w) => {
    if (isRowWidget(w)) return false;
    if (isListTopSpacer(w)) return false;
    if (isButtonSpacer(w)) return false;
    if (isBottomButton(w)) return false;
    if (isExtraPromptRow(w)) return false;
if (isGlobalSearchButton(w)) return false;
    if (w?._CSV_id === LIST_TOP_SPACER_ID) return false;
    if (w?._CSV_id === BUTTON_SPACER_ID) return false;
    if (w?._CSV_id === BUTTON_ID) return false;
    if (w?._CSV_id === EXTRA_PROMPT_ID) return false;
    return true;
  });
}
function isGlobalSearchButton(w) { return w?._CSV_id === GLOBAL_SEARCH_BUTTON_ID; }
function ensureGlobalSearchButton(node) {
  // 检查是否已经存在 (ID 复用)
  const existing = (node.widgets || []).find(w => w?._CSV_id === GLOBAL_SEARCH_BUTTON_ID);
  if (existing) return existing;
 
  // 创建组合控件
  const w = new SearchAndAddWidget();
  node.addCustomWidget(w);
  return w;
}
function ensureSelectButton(node) {
  const existing = (node.widgets || []).find(isBottomButton);
  if (existing) return existing;
  ensureListTopSpacer(node, 10);
  ensureButtonSpacer(node, 10);
  const btn = node.addWidget("button", BUTTON_LABEL, null, async () => {
    try {
        const files = await listPromptFiles();
        if (!files.length) {
            toast("warn", "No files", "No .csv files found in input/csv", 3500);
            return true;
        }
        const currentFiles = getRowWidgets(node)
            .filter(w => w.value.type === "CsvRowWidget" && w.value.file)
            .map(w => w.value.file);
        // 主按钮：默认开启多选模式 (true)
        const result = await showFilePickerModal(files, currentFiles, null, true);
        if (!result) return true;
        // 无论如何，主按钮的操作都视为 Global Sync
        const { files: pickedFiles } = result;
        const desiredSet = new Set(pickedFiles);
        // 1. 同步删除
        const allRows = getRowWidgets(node).filter(w => w.value.type === "CsvRowWidget");
        const rowsToRemove = [];
        for (const r of allRows) {
            if (r.value.file && !desiredSet.has(r.value.file)) {
                rowsToRemove.push(r);
            }
        }
        for (const r of rowsToRemove) {
            const idx = node.widgets.indexOf(r);
            if (idx !== -1) node.widgets.splice(idx, 1);
        }
        // 2. 同步添加
        const remainingFiles = new Set(
            getRowWidgets(node)
            .filter(w => w.value.type === "CsvRowWidget" && w.value.file)
            .map(w => w.value.file)
        );
        for (const f of pickedFiles) {
            if (!remainingFiles.has(f)) {
                node._csvRowCounter = (node._csvRowCounter || 0) + 1;
                const row = new CsvRowWidget("csv_" + node._csvRowCounter);
                node.addCustomWidget(row);
                row.value.order = getRowWidgets(node).length;
                await row.setFile(f);
                remainingFiles.add(f);
            }
        }
        layoutWidgets(node);
        recomputeNodeSize(node);
        node.setDirtyCanvas(true, true);
    } catch (e) {
        console.error(e);
        toast("error", "List Files", String(e?.message || e), 4500);
    }
    return true;
  });
  btn.serialize = false;
  btn._CSV_id = BUTTON_ID;
  layoutWidgets(node);
  return btn;
}
function getRowsInOrder(node) {
  return getRowWidgets(node);
}
function reorderDraggedRow(node, draggedRow, targetIndex) {
  const rows = getRowsInOrder(node);
  const from = rows.indexOf(draggedRow);
  if (from === -1) return false;
  const clamped = Math.max(0, Math.min(targetIndex, rows.length - 1));
  if (clamped === from) return false;
  const nextRows = rows.slice();
  nextRows.splice(from, 1);
  nextRows.splice(clamped, 0, draggedRow);
  const nonRows = (node.widgets || []).filter((w) => !isRowWidget(w));
  node.widgets = [...nonRows, ...nextRows];
  layoutWidgets(node);
  node.setDirtyCanvas(true, true);
  return true;
}
function computeTargetIndex(node, probeY, draggedRow, dirY = 0) {
  const rows = getRowsInOrder(node);
  const others = rows.filter((r) => r !== draggedRow);
  if (!others.length) return 0;
  let minY = Infinity;
  for (const r of others) {
    const ry = r?._rowY;
    if (typeof ry === "number" && ry < minY) minY = ry;
  }
  if (!Number.isFinite(minY)) minY = 10;
  const thresh = dirY >= 0 ? DRAG_SNAP_ENTER : DRAG_SNAP_EXIT;
  for (let i = 0; i < others.length; i++) {
    const r = others[i];
    const ry = typeof r?._rowY === "number" ? r._rowY : (minY + i * ROW_HEIGHT);
    const triggerLine = ry + ROW_HEIGHT * thresh;
    if (probeY < triggerLine) return i;
  }
  return others.length;
}
function drawDropPlaceholderAt(ctx, node, y) {
  if (typeof y !== "number") return;
  const x = LIST_SIDE_MARGIN;
  const w = Math.max(0, (node?.size?.[0] ?? 0) - LIST_SIDE_MARGIN * 2);
  const h = ROW_HEIGHT;
  const padY = 2;
  const yy = y + padY;
  const hh = h - padY * 2;
  ctx.save();
  ctx.globalAlpha = 0.16;
  ctx.fillStyle = "#000000";
  roundRectPath(ctx, x + 2, yy + 2, w - 4, hh - 4, 10);
  ctx.fill();
  ctx.globalAlpha = 0.18;
  ctx.fillStyle = "#ffffff";
  roundRectPath(ctx, x + 1, yy + 1, w - 2, hh - 2, 10);
  ctx.fill();
  ctx.globalAlpha = 0.28;
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1;
  roundRectPath(ctx, x + 1, yy + 1, w - 2, hh - 2, 10);
  ctx.stroke();
  ctx.restore();
}
function drawGhostRow(ctx, node, row, ghostY) {
  const x = LIST_SIDE_MARGIN;
  const w = Math.max(0, (node?.size?.[0] ?? 0) - LIST_SIDE_MARGIN * 2);
  ctx.save();
  ctx.globalAlpha = 0.25;
  ctx.fillStyle = "#000000";
  roundRectPath(ctx, x + 6, ghostY + 6, w - 12, ROW_HEIGHT - 6, 12);
  ctx.fill();
  ctx.globalAlpha = 0.98;
  row._render(ctx, node, w, ghostY, { ghost: true });
  ctx.globalAlpha = 0.35;
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1;
  roundRectPath(ctx, x + 1, ghostY + 1, w - 2, ROW_HEIGHT - 2, 10);
  ctx.stroke();
  ctx.restore();
}
function restoreOriginalOrder(node, originalRows) {
  if (!node || !Array.isArray(originalRows) || !originalRows.length) return;
  const currentRows = getRowsInOrder(node);
  const present = new Set(currentRows);
  const restored = originalRows.filter((r) => present.has(r));
  for (const r of currentRows) {
    if (!restored.includes(r)) restored.push(r);
  }
  const nonRows = (node.widgets || []).filter((w) => !isRowWidget(w));
  node.widgets = [...nonRows, ...restored];
  layoutWidgets(node);
  node.setDirtyCanvas(true, true);
}
function endDrag(node, commit = true) {
  const d = node?._CSVDrag;
  if (!d?.row) return;
  const row = d.row;
  row._dragging = false;
  row._hover = null;
  node._CSVDrag = null;
  CSVDragNode = null;
  if (!commit) {
    restoreOriginalOrder(node, d.originalRows);
  }
  setCanvasCursor("");
  updateRowOrders(node);
  node.setDirtyCanvas(true, true);
}
class SearchAndAddWidget {
  constructor() {
    this.name = "SearchAndAdd";
    this.type = "custom";
    this.value = { type: "SearchAndAddWidget", join_comma: true };
    this.serialize = false;
    this._CSV_id = GLOBAL_SEARCH_BUTTON_ID;
    this._hover = null;
    this._bounds = { search: [0, 0, 0, 0], add: [0, 0, 0, 0], folder: [0, 0, 0, 0], clear: [0, 0, 0, 0] };
  }
  computeSize() { return [0, 32]; }
  _hitPart(pos) {
    const x = pos[0];
    const y = pos[1];
    const inRect = (r) => x >= r[0] && x <= r[0] + r[2] && y >= r[1] && y <= r[1] + r[3];
    if (inRect(this._bounds.add)) return "add";
    if (inRect(this._bounds.folder)) return "folder";
    if (inRect(this._bounds.search)) return "search";
    if (inRect(this._bounds.clear)) return "clear";
    return null;
  }
  draw(ctx, node, width, y) {
    const margin = 10;
    const h = 32;
    const w = Math.max(0, width - margin * 2);
    const x = margin;
   
    const btnSize = h;
    const gap = 8;
    const clearW = 50;

    const clearX = x;
    const folderX = x + w - (btnSize * 2) - gap;
    const addX = folderX + btnSize + gap;
    
    // Search button fills the middle
    const searchX = clearX + clearW + gap;
    const searchW = Math.max(0, folderX - searchX - gap);
   
    // --- 0. Draw Clear Button (Left) ---
    ctx.save();
    const isClearHover = this._hover === "clear";
    ctx.fillStyle = isClearHover ? "#4a2b2b" : "#2b2b2b";
    roundRectPath(ctx, clearX, y, clearW, h, 6);
    ctx.fill();
    ctx.strokeStyle = isClearHover ? "#e05555" : "#555";
    ctx.lineWidth = 1;
    ctx.stroke();
    
    ctx.fillStyle = isClearHover ? "#ff8888" : "#ccc";
    ctx.font = "12px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Clear", clearX + clearW / 2, y + h / 2);
    ctx.restore();

    // --- 1. Draw Search Button (Middle) ---
    ctx.save();
    const isSearchHover = this._hover === "search";
    ctx.fillStyle = isSearchHover ? "#3a3a3a" : "#2b2b2b";
    roundRectPath(ctx, searchX, y, searchW, h, 6);
    ctx.fill();
    ctx.strokeStyle = "#555";
    ctx.lineWidth = 1;
    ctx.stroke();
   
    ctx.fillStyle = "#eee";
    ctx.font = "13px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(GLOBAL_SEARCH_BUTTON_LABEL, searchX + searchW / 2, y + h / 2);
    ctx.restore();

    // --- 3. Draw Folder (📁) Button (Middle-Right) ---
    ctx.save();
    const isFolderHover = this._hover === "folder";
    ctx.fillStyle = isFolderHover ? "#3a3a3a" : "#2b2b2b";
    roundRectPath(ctx, folderX, y, btnSize, h, 6);
    ctx.fill();
    ctx.strokeStyle = "#555";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 14px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("📁", folderX + btnSize / 2, y + h / 2);
    ctx.restore();

    // --- 4. Draw Add (+) Button (Right) ---
    ctx.save();
    const isAddHover = this._hover === "add";
    ctx.fillStyle = isAddHover ? "#358f4f" : "#2d7a40";
    roundRectPath(ctx, addX, y, btnSize, h, 6);
    ctx.fill();
    ctx.strokeStyle = isAddHover ? "#4caf50" : "#1f3a25";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = "#fff";
    ctx.font = "bold 18px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("+", addX + btnSize / 2, y + h / 2 + 1);
    ctx.restore();

    this._bounds.clear = [clearX, y, clearW, h];
    this._bounds.search = [searchX, y, searchW, h];
    this._bounds.folder = [folderX, y, btnSize, h];
    this._bounds.add = [addX, y, btnSize, h];
  }
  mouse(event, pos, node) {
    const t = event?.type || "";
    const isDown = (t === "pointerdown" || t === "mousedown");
    const isMove = (t === "pointermove" || t === "mousemove");
    const isLeave = (t === "pointerleave" || t === "mouseleave");
    if (isMove) {
        const part = this._hitPart(pos);
        if (this._hover !== part) {
            this._hover = part;
            node.setDirtyCanvas(true, false);
        }
        return true;
    }
   
    if (isLeave) {
        if (this._hover) {
            this._hover = null;
            node.setDirtyCanvas(true, false);
        }
    }
    if (isDown) {
        const part = this._hitPart(pos);
       
        if (part === "clear") {
            // Remove all CSV rows and Extra Prompts
            node.widgets = (node.widgets || []).filter(w => !isRowWidget(w));
            layoutWidgets(node);
            recomputeNodeSize(node);
            node.setDirtyCanvas(true, true);
            return true;
        }

        if (part === "search") {
            (async () => {
                const rows = getRowWidgets(node).filter(w => w.value.type === "CsvRowWidget");
                if (!rows.length) { toast("warn", "No CSVs", "Add CSV files first."); return; }
                const map = await showActiveRowsSearchModal(rows);
                if (!map) return;
                let changed = false;
                for (const r of rows) {
                  if (map.has(r.value.file)) {
                    const keys = Array.from(map.get(r.value.file));
                    if (keys.length === 0) {
                       if(r.value.key !== "(None)") { r.value.key = "(None)"; r.value.keys = []; changed = true; }
                    } else if (keys.length === 1) {
                       if(r.value.key !== keys[0]) { r.value.key = keys[0]; r.value.keys = []; changed = true; }
                    } else {
                       r.value.key = keys[0]; r.value.keys = keys; changed = true;
                    }
                  }
                }
                if (changed) node.setDirtyCanvas(true, true);
            })();
            return true;
        }
       
        if (part === "folder") {
            try {
                const csvPath = "/input/csv";
                if (window.electronAPI?.openPath) {
                    window.electronAPI.openPath(csvPath);
                } else if (window.showDirectoryPicker) {
                    toast("info", "CSV Folder", "CSV files are located in: " + csvPath, 3000);
                } else {
                    console.log("CSV folder path:", csvPath);
                    toast("info", "CSV Folder", "CSV folder: " + csvPath, 3000);
                }
            } catch (e) {
                console.error("Failed to open CSV folder:", e);
                toast("error", "Error", "Failed to open CSV folder", 3000);
            }
            return true;
        }

        if (part === "add") {
            let maxIdx = 0;
            const allExtras = (node.widgets || []).filter(w => w?.value?.type === "ExtraPromptWidget");
            allExtras.forEach(w => {
                 if (w.name.startsWith(EXTRA_PROMPT_NAME)) {
                     const suffix = w.name.replace(EXTRA_PROMPT_NAME, "").replace("_", "");
                     const idx = parseInt(suffix);
                     if (!isNaN(idx) && idx > maxIdx) maxIdx = idx;
                 }
            });
            const nextIdx = maxIdx + 1;
            const nextName = `${EXTRA_PROMPT_NAME}_${nextIdx}`;
           
            const w = new ExtraPromptWidget(nextName);
            w._CSV_id = `${EXTRA_PROMPT_ID}_${nextIdx}`;
           
            node.addCustomWidget(w);
            layoutWidgets(node);
            recomputeNodeSize(node);
            node.setDirtyCanvas(true, true);
            return true;
        }
    }
    return false;
  }
}
class ExtraPromptWidget {
  constructor(name) {
    this.name = name;
    this.type = "custom";
    this.value = { type: "ExtraPromptWidget", text: "", order: 0, join_comma: true };
    this._hover = null;
    this._rowY = null;
    this._dragging = false;
    this._bounds = {
      drag: [0, 0, 0, 0],
      edit: [0, 0, 0, 0],
      sub: [0, 0, 0, 0],
      comma: [0, 0, 0, 0],
    };
  }
  computeSize() { return [0, ROW_HEIGHT]; }
  serializeValue() { return this.value; }
  _hitPart(pos) {
    const x = pos[0];
    const y = pos[1];
    const inRect = (r) => x >= r[0] && x <= r[0] + r[2] && y >= r[1] && y <= r[1] + r[3];
    if (inRect(this._bounds.sub)) return "sub";
    if (inRect(this._bounds.comma)) return "comma";
    if (inRect(this._bounds.drag)) return "drag";
    if (inRect(this._bounds.edit)) return "edit";
    return null;
  }
  _render(ctx, node, _width, y, { ghost = false } = {}) {
    if (!ghost) this._rowY = y;
    const height = ROW_HEIGHT;
    const x = LIST_SIDE_MARGIN;
    const w = Math.max(0, (node?.size?.[0] ?? _width) - LIST_SIDE_MARGIN * 2);
    const innerPadY = 2;
    const yy = y + innerPadY;
    const hh = Math.max(0, height - innerPadY * 2);
    const handleW = DRAG_HANDLE_W;
    const gap = DRAG_HANDLE_GAP;
    const handleX = x;
    const handleY = yy;
    
    // Right side column width for controls (X and Comma)
    const controlColW = 30;
    
    // Main table width excludes handle and control column
    const tableX = x + handleW + gap;
    const tableW = Math.max(0, w - handleW - gap - controlColW);
    
    // Control column buttons position
    const controlX = tableX + tableW;
    const btnSize = hh / 2;
    
    // Rectangles for the buttons (Top Right = Remove, Bottom Right = Comma)
    const removeBtnY = yy;
    const commaBtnY = yy + btnSize;
    
    ctx.save();
    // 1. Drag Handle
    ctx.globalAlpha = 0.92;
    ctx.fillStyle = "#232323";
    roundRectPath(ctx, handleX, handleY, handleW, hh, 7);
    ctx.fill();
    ctx.globalAlpha = 0.85;
    ctx.strokeStyle = "#3f3f3f";
    ctx.lineWidth = 1;
    roundRectPath(ctx, handleX, handleY, handleW, hh, 7);
    ctx.stroke();
    if (this._hover === "drag" || this._dragging) drawHoverOverlay(ctx, handleX, handleY, handleW, hh, false);
    drawGripDots(ctx, handleX, handleY, handleW, hh, this._dragging);
    
    // 2. Main Content Background (Text Input)
    ctx.globalAlpha = 0.92;
    ctx.fillStyle = "#262626";
    roundRectPath(ctx, tableX, yy, tableW, hh, 7);
    ctx.fill();
    ctx.globalAlpha = 0.85;
    ctx.strokeStyle = "#3f3f3f";
    ctx.lineWidth = 1;
    roundRectPath(ctx, tableX, yy, tableW, hh, 7);
    ctx.stroke();
    
    // Text Area Hover
    if (this._hover === "edit") {
        drawHoverOverlay(ctx, tableX, yy, tableW, hh, false);
    }
    
    // 3. Remove Button (Top Right)
    // Background for Remove Button if hovered
    if (this._hover === "sub") {
         // Create a path that rounds the top-right corner
        ctx.save();
        ctx.beginPath();
        // Custom path or simple rect overlay? simple overlay is safer for now
        drawHoverOverlay(ctx, controlX, removeBtnY, controlColW, btnSize, true);
        ctx.restore();
    }
    // Draw X
    drawSmallX(ctx, controlX, removeBtnY, controlColW, btnSize, "#e05555");
    
    // 4. Comma Button (Bottom Right)
    const joinActive = this.value.join_comma !== false;
    
    // Background for Comma Button if hovered
    if (this._hover === "comma") {
        drawHoverOverlay(ctx, controlX, commaBtnY, controlColW, btnSize, false);
    }
    
    // Draw Comma Status Indicator (Background box)
    ctx.save();
    ctx.globalAlpha = 0.95;
    // Small centered box
    const boxS = 18;
    const boxX = controlX + (controlColW - boxS)/2;
    const boxY = commaBtnY + (btnSize - boxS)/2;
    
    ctx.fillStyle = joinActive ? "#1e2a1e" : "#2b2b2b";
    roundRectPath(ctx, boxX, boxY, boxS, boxS, 4);
    ctx.fill();
    
    // Draw Comma Symbol
    ctx.globalAlpha = 1.0;
    ctx.fillStyle = joinActive ? "#4ade80" : "#9ca3af";
    ctx.font = "bold 12px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(",", controlX + controlColW/2, commaBtnY + btnSize/2 - 1); // slight upward adjust for text
    ctx.restore();
    
    // 5. Draw text
    ctx.globalAlpha = 1.0;
    ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR;
    const prevFont = ctx.font;
    const prevAlign = ctx.textAlign;
    const prevBase = ctx.textBaseline;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    const mid = yy + hh / 2;
    ctx.save();
    ctx.globalAlpha = 0.80;
    ctx.fillText("Additional prompt:", tableX + 10, mid - 9);
    ctx.restore();
    const raw = String(this.value.text ?? "").replace(/\r/g, "");
    const firstLine = (raw.split("\n")[0] ?? "").trim();
    const preview = firstLine || "(click to edit)";
    ctx.save();
    ctx.globalAlpha = 0.95;
    ctx.fillText(ellipsizeToWidth(ctx, preview, tableW - 20), tableX + 10, mid + 9);
    ctx.restore();
    ctx.font = prevFont;
    ctx.textAlign = prevAlign;
    ctx.textBaseline = prevBase;
    ctx.restore();
    
    // Separator line between buttons (optional)
    ctx.save();
    ctx.globalAlpha = 0.3;
    ctx.strokeStyle = "#555";
    ctx.beginPath();
    ctx.moveTo(controlX, commaBtnY);
    ctx.lineTo(controlX + controlColW, commaBtnY);
    ctx.stroke();
    ctx.restore();

    if (!ghost) {
      this._bounds.drag = [handleX, handleY, handleW, hh];
      this._bounds.edit = [tableX, yy, tableW, hh];
      this._bounds.sub = [controlX, removeBtnY, controlColW, btnSize];
      this._bounds.comma = [controlX, commaBtnY, controlColW, btnSize];
    }
  }
  draw(ctx, node, _width, y) {
    const d = node?._CSVDrag;
    if (d?.row === this && this._dragging) {
      this._rowY = y;
      return;
    }
    this._render(ctx, node, _width, y, { ghost: false });
  }
  mouse(event, pos, node) {
    const t = event?.type || "";
    const isDown = (t === "pointerdown" || t === "mousedown");
    const isMove = (t === "pointermove" || t === "mousemove");
    const isUp = (
      t === "pointerup" || t === "mouseup" ||
      t === "pointercancel" || t === "mouseleave" || t === "pointerleave"
    );
    if (this._dragging) {
      if (isMove) {
        const buttons = typeof event?.buttons === "number" ? event.buttons : 1;
        if ((buttons & 1) === 0) {
          endDrag(node, false);
          return true;
        }
        const d = node._CSVDrag;
        if (!d) return true;
        const pointerY = pos?.[1];
        if (typeof pointerY === "number") {
          d.ghostY = pointerY - d.offsetY;
          const probeY = d.ghostY + ROW_HEIGHT * DRAG_SNAP_FRACTION;
          const lastProbeY = (typeof d.lastProbeY === "number") ? d.lastProbeY : probeY;
          const dirY = probeY - lastProbeY;
          d.lastProbeY = probeY;
          const targetIndex = computeTargetIndex(node, probeY, this, dirY);
          const rows = getRowsInOrder(node);
          const currentIndex = rows.indexOf(this);
          const clampedTarget = Math.max(0, Math.min(targetIndex, rows.length - 1));
          if (clampedTarget !== currentIndex) {
            reorderDraggedRow(node, this, clampedTarget);
          }
          node.setDirtyCanvas(true, true);
        }
        this._hover = "drag";
        setCanvasCursor("grabbing");
        return true;
      }
      if (isUp) {
        endDrag(node, true);
        return true;
      }
      return true;
    }
    if (!isDown) return false;
    if (event.button !== 0) return false;
    const part = this._hitPart(pos);
    // --- 逗号切换逻辑 ---
    if (part === "comma") {
        this.value.join_comma = !(this.value.join_comma !== false);
        node.setDirtyCanvas(true, true);
        return true;
    }
    // --- 删除逻辑 ---
    if (part === "sub") {
        const idx = node.widgets.indexOf(this);
        if (idx !== -1) {
            node.widgets.splice(idx, 1);
            layoutWidgets(node);
            recomputeNodeSize(node);
            node.setDirtyCanvas(true, true);
        }
        return true;
    }
    if (part === "drag") {
      const rows = getRowsInOrder(node);
      const startIndex = rows.indexOf(this);
      this._dragging = true;
      this._hover = "drag";
      const pointerY = pos?.[1] ?? 0;
      const rowTop = typeof this._rowY === "number" ? this._rowY : pointerY;
      const offsetY = pointerY - rowTop;
      node._CSVDrag = {
        row: this,
        offsetY,
        ghostY: rowTop,
        originalRows: rows.slice(),
        startIndex,
        lastProbeY: rowTop + ROW_HEIGHT * DRAG_SNAP_FRACTION,
      };
      CSVDragNode = node;
      setCanvasCursor("grabbing");
      node.setDirtyCanvas(true, true);
      return true;
    }
    if (part === "edit") {
      showAdditionalPromptModal(this.value.text || "").then((txt) => {
        if (txt === null) return;
        this.value.text = String(txt ?? "");
        layoutWidgets(node);
        node.setDirtyCanvas(true, true);
      });
      return true;
    }
    return false;
  }
}
function ensureExtraPromptRow(node) {
  const existing = (node.widgets || []).find(isExtraPromptRow);
  if (existing) return existing;
  const w = new ExtraPromptWidget(EXTRA_PROMPT_NAME);
  w._CSV_id = EXTRA_PROMPT_ID;
  node.addCustomWidget(w);
  layoutWidgets(node);
  return w;
}
class CsvRowWidget {
  constructor(name) {
    this.name = name;
    this.type = "custom";
    this.value = { type: "CsvRowWidget", file: "", key: "(None)", keys: [], order: 0, join_comma: true };
    this._labels = [];
    this._map = {};
    this._hover = null;
    this._rowY = null;
    this._dragging = false;
    this._bounds = {
      drag: [0, 0, 0, 0],
      file: [0, 0, 0, 0],
      edit: [0, 0, 0, 0],
      remove: [0, 0, 0, 0],
      comma: [0, 0, 0, 0],
      sel: [0, 0, 0, 0],
    };
  }
  computeSize() { return [0, ROW_HEIGHT]; }
  async setFile(filename) {
    this.value.file = filename;
    this.value.key = "(None)";
    this.value.keys = [];
    const data = await readPromptFile(filename);
    this._labels = ["(None)", "Random", ...(data.labels || [])];
    this._map = data.map || {};
  }
  serializeValue() { return this.value; }
  _getKeysEffective() {
    if (Array.isArray(this.value.key)) {
      return this.value.key.map(String).filter((s) => s && s !== "(None)");
    }
    const keys = Array.isArray(this.value.keys) ? this.value.keys.map(String).filter(Boolean) : [];
    if (keys.length) return keys.filter((s) => s !== "(None)");
    const k = String(this.value.key ?? "");
    if (!k || k === "(None)") return [];
    return [k];
  }
  _getSelPreviewText() {
    const keys = this._getKeysEffective();
    if (!keys.length) return "(None)";
    if (keys.length === 1) return keys[0];
    return `${keys.length} selected`;
  }
  _getOutPreview() {
    const keys = this._getKeysEffective();
    if (!keys.length) return "";
    const outs = [];
    for (const k of keys) {
      if (!k || k === "(None)") continue;
      if (k === "Random") {
        outs.push("(random pick at runtime)");
        continue;
      }
      const v = this._map[k];
      if (v) outs.push(v);
    }
    if (!outs.length) return "";
    return outs.join(" | ");
  }
async _handlePickFile(node) {
    try {
      const files = await listPromptFiles();
      if (!files.length) {
        toast("warn", "No files", "No .csv files found in input/csv", 3500);
        return;
      }
      const allNodeFiles = getRowWidgets(node)
          .map(w => w.value.type === "CsvRowWidget" ? w.value.file : null)
          .filter(Boolean);
      const currentFile = this.value.file || null;
      // 接收对象返回值 { mode, files }
      const result = await showFilePickerModal(files, allNodeFiles, currentFile, false);
      if (!result) return; // Cancelled
      const { mode, files: pickedFiles } = result;
      // === 场景 A: 单选模式 (Single Mode) ===
      if (mode === "single") {
          const targetFile = pickedFiles[0];
          // 逻辑：只替换当前行。
          // 哪怕文件已存在于其他行，也不删除其他行（允许重复）。
          // 哪怕点的是自己，也重新设置一遍无妨（或者判等跳过）。
          if (targetFile && targetFile !== this.value.file) {
              await this.setFile(targetFile);
          }
      }
      // === 场景 B: 多选模式 (Multi/Manager Mode) ===
      else {
          // 在多选模式下，用户意图是"管理整个列表"
          // pickedFiles 是用户最终想要的"全部文件集合"
          const desiredSet = new Set(pickedFiles);
         
          // 1. 删除逻辑：遍历现有行，如果其文件不在 desiredSet 中，则删除
          const allRows = getRowWidgets(node).filter(w => w.value.type === "CsvRowWidget");
          const rowsToRemove = [];
         
          for (const r of allRows) {
              // 注意：如果是空行(无文件)，通常不删，或者看需求。这里假设只管理有文件的行。
              if (r.value.file && !desiredSet.has(r.value.file)) {
                  rowsToRemove.push(r);
              }
          }
         
          for (const r of rowsToRemove) {
              const idx = node.widgets.indexOf(r);
              if (idx !== -1) node.widgets.splice(idx, 1);
          }
          // 2. 添加逻辑：遍历 desiredSet，如果节点中还没有该文件，则添加
          // 注意：如果节点里已经有A文件，就不再加A了（保持去重，或者说保持现有行状态）
          const remainingFiles = new Set(
              getRowWidgets(node)
              .filter(w => w.value.type === "CsvRowWidget" && w.value.file)
              .map(w => w.value.file)
          );
          for (const f of pickedFiles) {
              if (!remainingFiles.has(f)) {
                  node._csvRowCounter = (node._csvRowCounter || 0) + 1;
                  const newRow = new CsvRowWidget("csv_" + node._csvRowCounter);
                  node.addCustomWidget(newRow);
                  newRow.value.order = getRowWidgets(node).length;
                  await newRow.setFile(f);
                  // 标记已处理
                  remainingFiles.add(f);
              }
          }
      }
      layoutWidgets(node);
      recomputeNodeSize(node);
      node.setDirtyCanvas(true, true);
     
    } catch (e) {
      console.error(e);
      toast("error", "File Picker", String(e?.message || e), 4500);
    }
  }
  _handleRemove(node) {
    const idx = node.widgets.indexOf(this);
    if (idx !== -1) node.widgets.splice(idx, 1);
    layoutWidgets(node);
    recomputeNodeSize(node);
    node.setDirtyCanvas(true, true);
  }
  _hitPart(pos) {
    const x = pos[0];
    const y = pos[1];
    const inRect = (r) => x >= r[0] && x <= r[0] + r[2] && y >= r[1] && y <= r[1] + r[3];
    if (inRect(this._bounds.drag)) return "drag";
    if (inRect(this._bounds.remove)) return "remove";
    if (inRect(this._bounds.comma)) return "comma";
    if (this.value.file && inRect(this._bounds.edit)) return "edit";
    if (inRect(this._bounds.file)) return "file";
    if (inRect(this._bounds.sel)) return "sel";
    return null;
  }
  _render(ctx, node, _width, y, { ghost = false } = {}) {
    if (!ghost) this._rowY = y;
    const height = ROW_HEIGHT;
    const x = LIST_SIDE_MARGIN;
    const w = Math.max(0, (node?.size?.[0] ?? _width) - LIST_SIDE_MARGIN * 2);
    const innerPadY = 2;
    const yy = y + innerPadY;
    const hh = Math.max(0, height - innerPadY * 2);
    const handleW = DRAG_HANDLE_W;
    const gap = DRAG_HANDLE_GAP;
    const handleX = x;
    const handleY = yy;
    const handleH = hh;
    
    // Right side column width for controls (X and Comma)
    const controlColW = 30;

    // Main content area width
    const tableX = x + handleW + gap;
    const tableW = Math.max(0, w - handleW - gap - controlColW);
    
    // Control column buttons position
    const controlX = tableX + tableW;
    const btnSize = hh / 2;
    const removeBtnY = yy;
    const commaBtnY = yy + btnSize;

    const topH = Math.floor(hh * 0.52);
    const botH = hh - topH;
    const topY = yy;
    const botY = yy + topH;
    
    const editW = this.value.file ? 26 : 0;
    const fileW = tableW - editW;
    const fileX = tableX;
    const editX = fileX + fileW;
    
    // Bottom selection area
    const selW = Math.floor(tableW * 0.45);
    const outW = tableW - selW;
    const selX = tableX;
    const outX = selX + selW;

    ctx.save();
    // Drag Handle
    ctx.globalAlpha = 0.92;
    ctx.fillStyle = "#232323";
    roundRectPath(ctx, handleX, handleY, handleW, handleH, 7);
    ctx.fill();
    ctx.globalAlpha = 0.85;
    ctx.strokeStyle = "#3f3f3f";
    ctx.lineWidth = 1;
    roundRectPath(ctx, handleX, handleY, handleW, handleH, 7);
    ctx.stroke();
    if (this._hover === "drag" || this._dragging) drawHoverOverlay(ctx, handleX, handleY, handleW, handleH, false);
    drawGripDots(ctx, handleX, handleY, handleW, handleH, this._dragging);
    
    // Main Content Background
    ctx.globalAlpha = 0.92;
    ctx.fillStyle = "#262626";
    roundRectPath(ctx, tableX, yy, tableW, hh, 7);
    ctx.fill();
    ctx.globalAlpha = 0.85;
    ctx.strokeStyle = "#3f3f3f";
    ctx.lineWidth = 1;
    roundRectPath(ctx, tableX, yy, tableW, hh, 7);
    ctx.stroke();
    
    // Separator Lines within Main Content
    ctx.globalAlpha = 0.55;
    ctx.strokeStyle = "#3a3a3a";
    ctx.beginPath();
    ctx.moveTo(tableX + 6, botY);
    ctx.lineTo(tableX + tableW - 6, botY);
    ctx.moveTo(outX, botY + 3);
    ctx.lineTo(outX, botY + botH - 3);
    ctx.stroke();
    
    if (this._hover === "file") drawHoverOverlay(ctx, fileX, topY, fileW, topH, false);
    else if (this._hover === "edit") drawHoverOverlay(ctx, editX, topY, editW, topH, false);
    else if (this._hover === "sel") drawHoverOverlay(ctx, selX, botY, selW, botH, false);
    
    // --- Right Column Controls ---
    // Remove Button (Top Right)
    if (this._hover === "remove") {
         drawHoverOverlay(ctx, controlX, removeBtnY, controlColW, btnSize, true);
    }
    drawSmallX(ctx, controlX, removeBtnY, controlColW, btnSize, "#e05555");
    
    // Comma Button (Bottom Right)
    const joinActive = this.value.join_comma !== false;
    if (this._hover === "comma") {
        drawHoverOverlay(ctx, controlX, commaBtnY, controlColW, btnSize, false);
    }
    
    // Comma Box
    ctx.save();
    ctx.globalAlpha = 0.95;
    const boxS = 18;
    const boxX = controlX + (controlColW - boxS)/2;
    const boxY = commaBtnY + (btnSize - boxS)/2;
    ctx.fillStyle = joinActive ? "#1e2a1e" : "#2b2b2b";
    roundRectPath(ctx, boxX, boxY, boxS, boxS, 4);
    ctx.fill();
    
    // Comma Symbol
    ctx.globalAlpha = 1.0;
    ctx.fillStyle = joinActive ? "#4ade80" : "#9ca3af";
    ctx.font = "bold 12px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(",", controlX + controlColW/2, commaBtnY + btnSize/2 + 1);
    ctx.restore();
    
    // Control Column Separator Line
    ctx.save();
    ctx.globalAlpha = 0.3;
    ctx.strokeStyle = "#555";
    ctx.beginPath();
    ctx.moveTo(controlX, commaBtnY);
    ctx.lineTo(controlX + controlColW, commaBtnY);
    ctx.stroke();
    ctx.restore();

    // Text Content
    ctx.globalAlpha = 1.0;
    ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR;
    const prevFont = ctx.font;
    const prevAlign = ctx.textAlign;
    const prevBase = ctx.textBaseline;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.font = prevFont;
    
    const fileMid = topY + topH / 2;
    drawClippedText(ctx, this.value.file || "(click to choose file)", fileX, fileMid, fileW, topH);
    if (editW) {
      ctx.save(); ctx.textAlign = "center"; ctx.fillStyle = "#9ecbff";
      ctx.fillText("✎", editX + editW / 2, fileMid); ctx.restore();
    }

    const botMid = botY + botH / 2;
    const selText = this._getSelPreviewText();
    drawClippedText(ctx, selText, selX, botMid, selW, botH);
    const outVal = this._getOutPreview();
    drawClippedText(ctx, outVal, outX, botMid, outW, botH);

    ctx.font = prevFont;
    ctx.textAlign = prevAlign;
    ctx.textBaseline = prevBase;
    ctx.restore();
    
    if (!ghost) {
      this._bounds.drag = [handleX, handleY, handleW, handleH];
      this._bounds.file = [fileX, topY, fileW, topH];
      this._bounds.edit = [editX, topY, editW, topH];
      this._bounds.remove = [controlX, removeBtnY, controlColW, btnSize];
      this._bounds.comma = [controlX, commaBtnY, controlColW, btnSize];
      this._bounds.sel = [selX, botY, selW, botH];
    }
  }
  draw(ctx, node, _width, y) {
    const d = node?._CSVDrag;
    if (d?.row === this && this._dragging) {
      this._rowY = y;
      return;
    }
    this._render(ctx, node, _width, y, { ghost: false });
  }
  mouse(event, pos, node) {
    const t = event?.type || "";
    const isDown = (t === "pointerdown" || t === "mousedown");
    const isMove = (t === "pointermove" || t === "mousemove");
    const isUp = (
      t === "pointerup" || t === "mouseup" ||
      t === "pointercancel" || t === "mouseleave" || t === "pointerleave"
    );
    if (this._dragging) {
      if (isMove) {
        const buttons = typeof event?.buttons === "number" ? event.buttons : 1;
        if ((buttons & 1) === 0) {
          endDrag(node, false);
          return true;
        }
        const d = node._CSVDrag;
        if (!d) return true;
        const pointerY = pos?.[1];
        if (typeof pointerY === "number") {
          d.ghostY = pointerY - d.offsetY;
          const probeY = d.ghostY + ROW_HEIGHT * DRAG_SNAP_FRACTION;
          const lastProbeY = (typeof d.lastProbeY === "number") ? d.lastProbeY : probeY;
          const dirY = probeY - lastProbeY;
          d.lastProbeY = probeY;
          const targetIndex = computeTargetIndex(node, probeY, this, dirY);
          const rows = getRowsInOrder(node);
          const currentIndex = rows.indexOf(this);
          const clampedTarget = Math.max(0, Math.min(targetIndex, rows.length - 1));
          if (clampedTarget !== currentIndex) {
            reorderDraggedRow(node, this, clampedTarget);
          }
          node.setDirtyCanvas(true, true);
        }
        this._hover = "drag";
        setCanvasCursor("grabbing");
        return true;
      }
      if (isUp) {
        endDrag(node, true);
        return true;
      }
      return true;
    }
    if (!isDown) return false;
    if (event.button !== 0) return false;
    const part = this._hitPart(pos);
    if (part === "drag") {
      const rows = getRowsInOrder(node);
      const startIndex = rows.indexOf(this);
      this._dragging = true;
      this._hover = "drag";
      const pointerY = pos?.[1] ?? 0;
      const rowTop = typeof this._rowY === "number" ? this._rowY : pointerY;
      const offsetY = pointerY - rowTop;
      node._CSVDrag = {
        row: this,
        offsetY,
        ghostY: rowTop,
        originalRows: rows.slice(),
        startIndex,
        lastProbeY: rowTop + ROW_HEIGHT * DRAG_SNAP_FRACTION,
      };
      CSVDragNode = node;
      setCanvasCursor("grabbing");
      node.setDirtyCanvas(true, true);
      return true;
    }
    if (part === "remove") {
      this._handleRemove(node);
      return true;
    }
    if (part === "file") {
      this._handlePickFile(node);
      return true;
    }
    if (part === "edit") {
      openCsvEditor(this.value.file);
      return true;
    }
    if (part === "sel") {
      if (!this.value.file) return true;
      const items = (this._labels || []).map((label) => ({
        content: label,
        callback: () => {
          this.value.key = label;
          this.value.keys = [];
          node.setDirtyCanvas(true, true);
        },
      }));
      const preselected =
        Array.isArray(this.value.key) ? this.value.key :
          (Array.isArray(this.value.keys) && this.value.keys.length)
            ? this.value.keys
            : (this.value.key && this.value.key !== "(None)" ? [String(this.value.key)] : []);
      showKeyPickerMenu(items, event, "Selection", { selected: preselected }).then((result) => {
        if (!result) return;
        if (result.mode === "single") {
          const picked = String(result.picked?.content ?? "");
          if (!picked || picked === "(None)") {
            this.value.key = "(None)";
            this.value.keys = [];
          } else {
            this.value.key = picked;
            this.value.keys = [];
          }
          node.setDirtyCanvas(true, true);
          return;
        }
        if (result.mode === "clear") {
          this.value.key = "(None)";
          this.value.keys = [];
          node.setDirtyCanvas(true, true);
          return;
        }
        if (result.mode === "multi") {
          const chosen = Array.isArray(result.selected) ? result.selected : [];
          const cleaned = chosen.map(String).filter((s) => s && s !== "(None)");
          if (cleaned.length <= 1) {
            const one = cleaned[0] || "(None)";
            this.value.key = one;
            this.value.keys = [];
          } else {
            this.value.key = cleaned.slice();
            this.value.keys = cleaned.slice();
          }
          node.setDirtyCanvas(true, true);
          return;
        }
      });
      return true;
    }
    // 逗号按钮点击处理
    if (part === "comma") {
        this.value.join_comma = !(this.value.join_comma !== false);
        node.setDirtyCanvas(true, true);
        return true;
    }
    return false;
  }
}
app.registerExtension({
  name: "CSV.multilang_csv_prompt_picker1",
  async nodeCreated(node) {
    if (node.comfyClass !== NODE_NAME) return;
    // 参考vsLinx：禁用serialize_widgets，使用node.properties保存自定义数据
    node.serialize_widgets = false;
    // 添加保存机制
    const origOnSerialize = node.onSerialize;
    node.onSerialize = function (o) {
      origOnSerialize?.call(this, o);
      try {
        o.properties = o.properties || {};
        const rows = (this.widgets || []).filter((w) => w?.value?.type === "CsvRowWidget").map((w) => ({ ...(w.value || {}) }));
        const extras = (this.widgets || []).filter((w) => w?.value?.type === "ExtraPromptWidget").map((w) => ({ ...(w.value || {}) }));
        o.properties.vslinx_csv_rows = rows;
        o.properties.vslinx_extra_prompts = extras;
        o.properties.vslinx_csv_prompt_picker_v = 2;
      } catch (e) {
        console.warn("[csv_prompt_picker] onSerialize failed:", e);
      }
    };
    const origOnDrawForeground = node.onDrawForeground;
    node.onDrawForeground = function (ctx) {
      origOnDrawForeground?.call(this, ctx);
      const d = this._CSVDrag;
      if (!d?.row || !d.row._dragging) return;
      const slotY = d.row?._rowY;
      drawDropPlaceholderAt(ctx, this, slotY);
      drawGhostRow(ctx, this, d.row, d.ghostY);
    };
    if (!app.canvas._CSVProcessMouseMovePatched) {
      app.canvas._CSVProcessMouseMovePatched = true;
      const orig = app.canvas.processMouseMove.bind(app.canvas);
      app.canvas.processMouseMove = function (e) {
        const r = orig(e);
        if (isDragging()) {
          setCanvasCursor("grabbing");
          return r;
        }
        if (CSVHoverNode) {
          const over = this.node_over;
          if (over !== CSVHoverNode) {
            clearHoverOnNode(CSVHoverNode);
            CSVHoverNode = null;
            setCanvasCursor("");
          }
        }
        return r;
      };
    }
    if (!app.canvas._CSVMouseLeaveBound) {
      app.canvas._CSVMouseLeaveBound = true;
      const c = app?.canvas?.canvas;
      const cancelAll = () => {
        if (CSVDragNode?._CSVDrag?.row?._dragging) {
          endDrag(CSVDragNode, false);
        }
        if (CSVHoverNode) {
          clearHoverOnNode(CSVHoverNode);
          CSVHoverNode = null;
        }
        setCanvasCursor("");
      };
      const commitAll = () => {
        if (CSVDragNode?._CSVDrag?.row?._dragging) {
          endDrag(CSVDragNode, true);
        }
        setCanvasCursor("");
      };
      if (c) {
        c.addEventListener("mouseleave", cancelAll);
        c.addEventListener("pointerleave", cancelAll);
      }
      window.addEventListener("blur", cancelAll, true);
      window.addEventListener("pointercancel", cancelAll, true);
      window.addEventListener("mouseup", commitAll, true);
      window.addEventListener("pointerup", commitAll, true);
    }
    const origOnMouseMove = node.onMouseMove;
    node.onMouseMove = function (e, pos, canvas) {
      origOnMouseMove?.call(this, e, pos, canvas);
      CSVHoverNode = this;
      const rows = getRowWidgets(this);
      if (rows.some((r) => r?._dragging)) {
        setCanvasCursor("grabbing");
        return;
      }
      let cursor = "";
      let didAnyChange = false;
      for (const row of rows) {
        const rowY = row._rowY;
        if (typeof rowY !== "number") continue;
        const inThisRow = pos[1] >= rowY && pos[1] <= rowY + ROW_HEIGHT;
        if (!inThisRow) {
          if (row._hover) {
            row._hover = null;
            didAnyChange = true;
          }
          continue;
        }
        const part = row._hitPart(pos);
        if (row._hover !== part) {
          row._hover = part;
          didAnyChange = true;
        }
        if (part === "drag") cursor = "grab";
        else if (part) cursor = "pointer";
      }
      if (didAnyChange) this.setDirtyCanvas(true, true);
      setCanvasCursor(cursor);
    };
    const origConfigure = node.configure;
    node.configure = function (info) {
      // 保护内置widgets不受自定义行对象影响
      const originalInfo = info;
      const safeInfo = (() => {
        try {
          if (!originalInfo || !Array.isArray(originalInfo.widgets_values)) return originalInfo;
          const filtered = originalInfo.widgets_values.filter((v) => {
            return !(v && typeof v === "object" && (v.type === "CsvRowWidget" || v.type === "ExtraPromptWidget"));
          });
          return { ...originalInfo, widgets_values: filtered };
        } catch (_) {
          return originalInfo;
        }
      })();
      origConfigure?.call(node, safeInfo);
      if (CSVDragNode === node && node._CSVDrag?.row?._dragging) {
        endDrag(node, false);
      }
      removeAllCSVUiWidgets(node);
      ensureListTopSpacer(node, 10);
      ensureButtonSpacer(node, 10);
      // 这里的 ensureGlobalSearchButton 现在会创建 Search+Add 组合控件
      if (typeof ensureGlobalSearchButton === "function") ensureGlobalSearchButton(node);
      if (typeof ensureSelectButton === "function") ensureSelectButton(node);
      // 从node.properties恢复数据（新格式），回退到legacy widgets_values
      const propRows = originalInfo?.properties?.vslinx_csv_rows;
      const propExtras = originalInfo?.properties?.vslinx_extra_prompts;
     
      const legacyVals = Array.isArray(originalInfo?.widgets_values) ? originalInfo.widgets_values : [];
      const legacyExtras = legacyVals.filter((v) => v && typeof v === "object" && v.type === "ExtraPromptWidget");
      const legacyRows = legacyVals.filter((v) => v && typeof v === "object" && v.type === "CsvRowWidget" && v.file);
      const savedExtras = Array.isArray(propExtras) ? propExtras : legacyExtras;
     
      // 注意：这里不再自动创建默认行，如果没有保存记录，列表就是空的
      if (savedExtras.length > 0) {
          savedExtras.forEach((sVal, index) => {
              const name = index === 0 ? EXTRA_PROMPT_NAME : `${EXTRA_PROMPT_NAME}_${index + 1}`;
              const w = new ExtraPromptWidget(name);
              w._CSV_id = index === 0 ? EXTRA_PROMPT_ID : `${EXTRA_PROMPT_ID}_${index + 1}`;
              w.value = { ...w.value, ...sVal };
              node.addCustomWidget(w);
          });
      }
      const savedRows = Array.isArray(propRows) ? propRows.filter((v) => v && v.type === "CsvRowWidget" && v.file) : legacyRows;
      try {
        node.properties = node.properties || {};
        // 如果从legacy widgets_values加载（没有properties），迁移以便将来保存干净
        if (!Array.isArray(originalInfo?.properties?.vslinx_csv_rows) && Array.isArray(savedRows)) {
          node.properties.vslinx_csv_rows = savedRows.map((v) => ({ ...(v || {}) }));
        }
        if (!Array.isArray(originalInfo?.properties?.vslinx_extra_prompts) && Array.isArray(savedExtras)) {
          node.properties.vslinx_extra_prompts = savedExtras.map((v) => ({ ...(v || {}) }));
        }
        node.properties.vslinx_csv_prompt_picker_v = 2;
      } catch (_) { }
      node._csvRowCounter = 0;
      for (const v of savedRows) {
        node._csvRowCounter += 1;
        const row = new CsvRowWidget("csv_" + node._csvRowCounter);
        node.addCustomWidget(row);
        const merged = { ...row.value, ...v };
        if (!Array.isArray(merged.keys)) merged.keys = [];
        if (Array.isArray(merged.key)) {
          merged.keys = merged.key.slice();
        }
        row.value = merged;
        row.setFile(v.file).then(() => {
          row.value.key = v.key ?? "(None)";
          if (Array.isArray(v.key)) row.value.keys = v.key.slice();
          if (Array.isArray(v.keys) && v.keys.length && !Array.isArray(row.value.key)) row.value.keys = v.keys.slice();
          layoutWidgets(node);
          node.setDirtyCanvas(true, true);
        }).catch((e) => {
          console.warn("[vsLinx] restore setFile failed for", v.file, e);
          layoutWidgets(node);
          node.setDirtyCanvas(true, true);
        });
      }
      node._CSVDrag = null;
      // 排序与布局
      const rows = getRowWidgets(node).slice();
      rows.sort((a, b) => {
        const ao = Number.isFinite(a?.value?.order) ? a.value.order : 0;
        const bo = Number.isFinite(b?.value?.order) ? b.value.order : 0;
        if (ao !== bo) return ao - bo;
        return 0;
      });
      const nonRows = (node.widgets || []).filter((w) => !isRowWidget(w));
      node.widgets = [...nonRows, ...rows];
      layoutWidgets(node);
      recomputeNodeSize(node);
      node.setDirtyCanvas(true, true);
    };
    removeAllCSVUiWidgets(node);
    ensureListTopSpacer(node, 10);
    ensureButtonSpacer(node, 10);
ensureGlobalSearchButton(node);
    ensureSelectButton(node);
    //ensureExtraPromptRow(node);
    node._CSVDrag = null;
    layoutWidgets(node);
	node.size = [330, 100]; // 2. 添加这一行，手动设置默认宽度 (450可按需调整)
    recomputeNodeSize(node);
  },
});
