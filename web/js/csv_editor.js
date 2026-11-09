import { api } from "/scripts/api.js";

let editorActive = false;

async function requestDocument(url, options) {
  const response = await api.fetchApi(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 404 && !data.error) {
      throw new Error("编辑接口尚未加载，请先重启 ComfyUI 后端，再刷新页面。");
    }
    throw new Error(data.error || `请求失败 (${response.status})`);
  }
  return data;
}

export async function showCsvEditor(filename, { onSaved } = {}) {
  if (editorActive) return;
  editorActive = true;
  let documentData;
  try {
    documentData = await requestDocument(`/CSV/csv_prompt_edit?filename=${encodeURIComponent(filename)}`);
  } catch (error) {
    editorActive = false;
    throw error;
  }
  let rows = documentData.rows.map(row => row.slice());
  let baseline = JSON.stringify(rows);
  let selected = rows.length ? 0 : -1;
  let busy = false;
  let closed = false;
  let discardVisible = false;
  const previousFocus = document.activeElement;
  const overlay = document.createElement("div");
  overlay.className = "csv-editor-overlay";
  overlay.setAttribute("data-csv-editor", "");
  const style = document.createElement("style");
  style.textContent = `
    .csv-editor-overlay { position:fixed;inset:0;z-index:1000001;background:#000a;display:flex;align-items:center;justify-content:center;padding:18px;color:#eee;font:13px sans-serif; }
    .csv-editor-overlay * { box-sizing:border-box; }
    .csv-editor-dialog { width:1000px;max-width:100%;height:min(760px,90vh);background:#202024;border:1px solid #555;border-radius:12px;box-shadow:0 18px 70px #0008;display:flex;flex-direction:column;padding:18px;gap:12px; }
    .csv-editor-overlay h2 { margin:0;font-size:18px;color:#f4f4f5; }
    .csv-editor-meta { color:#a1a1aa;font-size:12px;overflow-wrap:anywhere; }
    .csv-editor-toolbar,.csv-editor-footer,.csv-editor-save-as,.csv-editor-discard { display:flex;align-items:center;gap:8px;flex-wrap:wrap; }
    .csv-editor-overlay button { padding:8px 12px;border:1px solid #555;border-radius:7px;background:#303036;color:#eee;cursor:pointer;font:inherit; }
    .csv-editor-overlay button:hover:not(:disabled) { background:#414149; }
    .csv-editor-overlay button:disabled { opacity:.4;cursor:default; }
    .csv-editor-overlay button.csv-editor-primary { background:#24653b;border-color:#368d53; }
    .csv-editor-overlay button.csv-editor-danger { color:#ffb3b3; }
    .csv-editor-overlay input,.csv-editor-overlay textarea { width:100%;border:1px solid #555;border-radius:7px;padding:9px;background:#151518;color:#eee;font:13px/1.5 ui-monospace,Consolas,monospace; }
    .csv-editor-overlay input:focus,.csv-editor-overlay textarea:focus,.csv-editor-overlay button:focus-visible { outline:2px solid #69a5e8;outline-offset:1px; }
    .csv-editor-toolbar input { flex:1;min-width:160px; }
    .csv-editor-body { display:grid;grid-template-columns:minmax(170px,30%) minmax(0,1fr);flex:1;min-height:0;gap:14px; }
    .csv-editor-list { overflow:auto;background:#17171a;border:1px solid #3f3f46;border-radius:8px;padding:5px; }
    .csv-editor-overlay .csv-editor-row { display:block;width:100%;padding:9px;text-align:left;border:1px solid transparent;background:transparent;overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
    .csv-editor-overlay .csv-editor-row[aria-selected=true] { background:#203b55;border-color:#4684b9; }
    .csv-editor-fields { overflow:auto;min-width:0;padding:2px 3px; }
    .csv-editor-fields label { display:block;margin:0 0 14px; }
    .csv-editor-fields label span { display:block;color:#c4c4cc;margin-bottom:6px; }
    .csv-editor-fields textarea { min-height:110px;resize:vertical; }
    .csv-editor-fields textarea[data-column="0"] { min-height:56px; }
    .csv-editor-fields textarea.csv-editor-prompt { min-height:230px; }
    .csv-editor-note { color:#a1a1aa;font-size:12px;line-height:1.6; }
    .csv-editor-status { min-height:18px;font-size:12px;line-height:1.5;overflow-wrap:anywhere; }
    .csv-editor-status[data-error=true] { color:#ffabab; }
    .csv-editor-status[data-error=false] { color:#a7dcb4; }
    .csv-editor-save-as { border-top:1px solid #3f3f46;padding-top:10px; }
    .csv-editor-save-as input { flex:1;min-width:180px; }
    .csv-editor-discard { background:#493722;padding:10px;border-radius:7px; }
    .csv-editor-footer { justify-content:space-between; }
    .csv-editor-actions { display:flex;gap:8px; }
    @media(max-width:600px) { .csv-editor-overlay { padding:8px; } .csv-editor-dialog { padding:12px;height:95vh; } .csv-editor-body { grid-template-columns:minmax(110px,35%) minmax(0,1fr);gap:8px; } }
  `;
  overlay.append(style);
  const make = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const card = make("section", "csv-editor-dialog");
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");
  card.setAttribute("aria-label", "编辑 CSV");
  const title = make("h2");
  const meta = make("div", "csv-editor-meta");
  const toolbar = make("div", "csv-editor-toolbar");
  const search = make("input");
  search.placeholder = "搜索标签或提示词…";
  search.setAttribute("aria-label", "搜索条目");
  const button = (label, action, className) => {
    const b = make("button", className, label);
    b.type = "button";
    b.onclick = action;
    return b;
  };
  const dirty = () => JSON.stringify(rows) !== baseline;
  const status = make("div", "csv-editor-status");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const setStatus = (message, error = false) => {
    status.textContent = message;
    status.dataset.error = String(error);
  };
  const updateHeader = () => {
    title.textContent = `编辑 CSV · ${documentData.filename}${dirty() ? " *" : ""}`;
    const delimiter = documentData.delimiter === "\t" ? "Tab" : documentData.delimiter;
    meta.textContent = `${rows.length} 行 · ${documentData.encoding} · 分隔符 ${delimiter} · ${documentData.newline === "\r\n" ? "CRLF" : documentData.newline === "\r" ? "CR" : "LF"}`;
    save.disabled = busy || !dirty();
    duplicate.disabled = busy || selected < 0;
    remove.disabled = busy || selected < 0;
    addColumn.disabled = busy || selected < 0;
    if (dirty() && !busy && status.dataset.error !== "true") setStatus("有未保存的修改");
    else if (!dirty() && status.textContent === "有未保存的修改") setStatus("");
  };
  const body = make("div", "csv-editor-body");
  const list = make("div", "csv-editor-list");
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "CSV 条目");
  const fields = make("div", "csv-editor-fields");
  const rowText = (row, index) => `${index + 1}. ${row[0] || "(空行)"}`;
  const renderList = () => {
    const scroll = list.scrollTop;
    list.replaceChildren();
    const needle = search.value.toLocaleLowerCase().trim();
    rows.forEach((row, index) => {
      if (needle && !row.some(cell => cell.toLocaleLowerCase().includes(needle))) return;
      const item = button(rowText(row, index), () => { selected = index; render(); }, "csv-editor-row");
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(selected === index));
      item.title = row.join(" | ");
      item.dataset.rowIndex = String(index);
      list.append(item);
    });
    if (!list.childElementCount) list.append(make("p", "csv-editor-note", "没有匹配的条目"));
    list.scrollTop = scroll;
  };
  const renderFields = () => {
    fields.replaceChildren();
    if (selected < 0 || !rows[selected]) {
      fields.append(make("p", "csv-editor-note", "点击“新增”创建条目，或从左侧选择一行。"));
      return;
    }
    const index = selected;
    const row = rows[index];
    const info = make("p", "csv-editor-note", `第 ${index + 1} 行 · ${row.length} 列。单列内容同时用作标签与输出；两列时第 1 列是标签，第 2 列是提示词。`);
    fields.append(info);
    const duplicateCount = rows.filter(r => r[0]?.trim() && r[0].trim() === row[0]?.trim()).length;
    if (duplicateCount > 1) fields.append(make("p", "csv-editor-note", `该标签出现 ${duplicateCount} 次。编辑器保留所有行，节点运行时沿用最后一个同名标签的值。`));
    for (let column = 0; column < Math.max(1, row.length); column++) {
      const label = make("label");
      const caption = column === 0 ? (row.length <= 1 ? "标签 / 提示词（单列）" : "标签（第 1 列）") : column === 1 ? "提示词（第 2 列）" : `额外内容（第 ${column + 1} 列）`;
      const input = make("textarea", column === 1 ? "csv-editor-prompt" : "");
      input.value = row[column] ?? "";
      input.rows = column === 0 ? 2 : 6;
      input.dataset.column = String(column);
      input.setAttribute("aria-label", caption);
      input.oninput = () => {
        rows[index][column] = input.value;
        updateHeader();
        // Keep the active field and its selection intact while typing.
        const item = list.querySelector(`[data-row-index="${index}"]`);
        if (item) { item.textContent = rowText(rows[index], index); item.title = rows[index].join(" | "); }
      };
      label.append(make("span", "", caption), input);
      fields.append(label);
    }
    fields.append(make("p", "csv-editor-note", "空格、逗号、引号和换行会按 CSV 规则保存；额外列会保留。标签改名或删除后，失效的节点选择会清除。"));
  };
  const render = () => { renderList(); renderFields(); updateHeader(); };
  const add = button("新增", () => {
    const width = rows[selected]?.length || rows.find(row => row.length)?.length || 2;
    rows.push(Array(width).fill("")); selected = rows.length - 1; search.value = ""; render();
    list.scrollTop = list.scrollHeight; fields.querySelector("textarea")?.focus();
  });
  const duplicate = button("复制", () => {
    if (selected < 0) return;
    rows.splice(selected + 1, 0, rows[selected].slice()); selected++; render();
  });
  const remove = button("删除", () => {
    if (selected < 0) return;
    rows.splice(selected, 1); selected = Math.min(selected, rows.length - 1); render();
  }, "csv-editor-danger");
  const addColumn = button("添加一列", () => {
    if (selected < 0) return;
    rows[selected].push(""); render(); fields.lastElementChild?.previousElementSibling?.querySelector("textarea")?.focus();
  });
  toolbar.append(search, add, duplicate, remove, addColumn);
  search.oninput = renderList;
  body.append(list, fields);
  const saveAsBar = make("div", "csv-editor-save-as");
  const saveAsName = make("input");
  saveAsName.setAttribute("aria-label", "另存为文件名");
  const suggestedCopy = () => documentData.filename.replace(/\.csv$/i, "_copy.csv");
  saveAsName.value = suggestedCopy();
  const setBusy = value => {
    busy = value;
    card.querySelectorAll("button,input,textarea").forEach(control => { control.disabled = value; });
    updateHeader();
  };
  const saveDocument = async asCopy => {
    if (busy || closed) return;
    const target = asCopy ? saveAsName.value.trim() : null;
    if (asCopy && (!target || target.replaceAll("\\", "/") === documentData.filename)) {
      setStatus("另存为请使用不同的 .csv 文件名。路径相对于 input/csv。", true); return;
    }
    setBusy(true); setStatus("正在保存…");
    let result;
    try {
      result = await requestDocument("/CSV/csv_prompt_save", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: documentData.filename, revision: documentData.revision, rows, save_as: target }),
      });
      documentData = result;
      rows = result.rows.map(row => row.slice());
      baseline = JSON.stringify(rows);
      saveAsName.value = suggestedCopy();
      render();
    } catch (error) {
      setStatus(error.message || String(error), true);
    }
    if (result) {
      try {
        await onSaved?.(result.filename);
        const backupText = result.backup ? `；备份：${result.backup}` : "";
        setStatus(`已保存 ${result.filename}${backupText}${asCopy ? "。副本可在 CSV 文件列表中选择。" : ""}`);
      } catch (error) {
        setStatus(`文件已保存，但节点刷新失败：${error.message || error}。请刷新页面。`, true);
      }
    }
    setBusy(false);
  };
  const saveAs = button("另存为", () => saveDocument(true));
  saveAsBar.append(make("span", "csv-editor-note", "相对 input/csv："), saveAsName, saveAs);
  const discard = make("div", "csv-editor-discard");
  discard.style.display = "none";
  const close = force => {
    if (busy || closed) return;
    if (dirty() && !force) {
      discardVisible = true; discard.style.display = "flex"; return;
    }
    closed = true;
    editorActive = false;
    document.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("beforeunload", onBeforeUnload);
    overlay.remove();
    if (previousFocus?.isConnected) previousFocus.focus?.();
  };
  discard.append(make("span", "", "有未保存的修改。"), button("继续编辑", () => { discardVisible = false; discard.style.display = "none"; }), button("放弃修改并关闭", () => close(true), "csv-editor-danger"));
  const footer = make("div", "csv-editor-footer");
  const actions = make("div", "csv-editor-actions");
  const save = button("保存  Ctrl+S", () => saveDocument(false), "csv-editor-primary");
  actions.append(button("关闭", () => close(false)), save);
  footer.append(make("span", "csv-editor-note", "保存到原文件前会自动备份。"), actions);
  const onKeyDown = event => {
    event.stopPropagation();
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault(); saveDocument(false);
    } else if (event.key === "Escape") {
      event.preventDefault();
      if (discardVisible) { discardVisible = false; discard.style.display = "none"; }
      else close(false);
    } else if (event.key === "Tab") {
      const controls = [...card.querySelectorAll("button,input,textarea")].filter(el => !el.disabled && el.getClientRects().length);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  };
  const onBeforeUnload = event => { if (dirty()) { event.preventDefault(); event.returnValue = ""; } };
  overlay.onclick = event => { if (event.target === overlay) close(false); };
  card.append(title, meta, toolbar, body, status, saveAsBar, discard, footer);
  overlay.append(card); document.body.append(overlay);
  document.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("beforeunload", onBeforeUnload);
  render(); search.focus();
}
