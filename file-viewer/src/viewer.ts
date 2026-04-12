import type { ViewerProps } from "@dotdirfm/extension-api";

const SCROLLBAR_WIDTH = 10;
const SCROLLBAR_PADDING = 6;
const TAB_SIZE = 8;
/** Vertical rhythm for text/hex rows (scroll math uses `rowH` = char cell × this). */
const LINE_HEIGHT_RATIO = 1.5;
const BLOCK_SIZE = 64 * 1024;
const BACKWARD_SEARCH_MAX = 100_000; // MC uses 100,000

type EncodingId = "ascii" | "utf-8" | "windows-1251" | "koi8-r" | "iso-8859-1";

interface Seg {
  text: string;
  style?: string;
}
interface GridLine {
  text: string;
  byteStart: number;
  byteEnd: number;
  charOffsets: number[];
}

// ── Module state ───────────────────────────────────────────────────────────────
let _path = "";
let fileSize = 0;
let dpyStart = 0;
let wrapMode = true;
let dpyParagraphSkipLines = 0;
let dpyTextColumn = 0;
let hexMode = false;
let hexCursor = 0;
let bytesPerLine = 16;
let encoding: EncodingId = "ascii";
let singleByteDecoder: TextDecoder | null = null;
const utf8Dec = new TextDecoder("utf-8", { fatal: true });

let inputBarMode: "search" | "goto" | null = null;
let searchQuery = "";
let searchMatchStart = -1;
let searchMatchEnd = -1;
let searchCaseSensitive = true;
let lastSearchDir: "forward" | "backward" = "forward";

let charW = 8,
  charH = 16,
  rowH = 24,
  rows = 20,
  cols = 80;

let frameDiv: HTMLDivElement | null = null;
let contentDiv: HTMLDivElement | null = null;
let statusDiv: HTMLDivElement | null = null;
let inputBarDiv: HTMLDivElement | null = null;
let inputBarInput: HTMLInputElement | null = null;
let inputBarLabel: HTMLSpanElement | null = null;
let inputBarStatus: HTMLSpanElement | null = null;
let inputBarCase: HTMLInputElement | null = null;
let scrollbarTrack: HTMLDivElement | null = null;
let scrollbarThumb: HTMLDivElement | null = null;
let hexBtn: HTMLButtonElement | null = null;
let wrapChk: HTMLInputElement | null = null;

let resizeHandler: (() => void) | null = null;
let wheelHandler: ((e: WheelEvent) => void) | null = null;
let ptrMoveHandler: ((e: PointerEvent) => void) | null = null;
let ptrUpHandler: ((e: PointerEvent) => void) | null = null;
let inputKeydownHandler: ((e: KeyboardEvent) => void) | null = null;
let commandDisposers: Array<{ dispose: () => void }> = [];
let inertiaFrame: number | null = null;
let lastTouchY = 0,
  lastTouchTime = 0,
  touchVelocity = 0;
let dragging = false,
  dragOffsetY = 0;
let lastEndByte = 0;

let cacheOff = -1;
let cacheBuf: Uint8Array | null = null;
let cacheLen = 0;
let disposeFileChange: (() => void) | null = null;

// ── Utilities ──────────────────────────────────────────────────────────────────
function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1073741824) return `${(b / 1048576).toFixed(1)} MB`;
  return `${(b / 1073741824).toFixed(1)} GB`;
}
const hex8 = (n: number) => n.toString(16).toUpperCase().padStart(8, "0");
const hex2 = (b: number) => b.toString(16).toUpperCase().padStart(2, "0");
function clamp(n: number) {
  return fileSize <= 0 ? 0 : Math.max(0, Math.min(n, fileSize - 1));
}

function disposeCommands() {
  for (const disposable of commandDisposers) {
    try {
      disposable.dispose();
    } catch {
      // ignore
    }
  }
  commandDisposers = [];
}

// ── Data source ────────────────────────────────────────────────────────────────
async function readRange(off: number, len: number): Promise<Uint8Array> {
  return new Uint8Array(await dotdir.readFileRange(_path, off, len));
}

async function loadBlock(idx: number) {
  const boff = Math.max(
    0,
    Math.min(fileSize, Math.floor(idx / BLOCK_SIZE) * BLOCK_SIZE),
  );
  if (cacheBuf && cacheOff === boff) return;
  const b = await readRange(boff, BLOCK_SIZE);
  cacheOff = boff;
  cacheBuf = b;
  cacheLen = b.length;
}

async function getByte(idx: number): Promise<number | null> {
  if (idx < 0 || idx >= fileSize) return null;
  await loadBlock(idx);
  if (!cacheBuf) return null;
  const i = idx - cacheOff;
  return i >= 0 && i < cacheLen ? cacheBuf[i]! : null;
}

async function peekBytes(idx: number, n: number): Promise<Uint8Array> {
  const out = new Uint8Array(Math.min(n, Math.max(0, fileSize - idx)));
  for (let i = 0; i < out.length; i++) {
    const b = await getByte(idx + i);
    if (b == null) return out.subarray(0, i);
    out[i] = b;
  }
  return out;
}

// ── Encoding ───────────────────────────────────────────────────────────────────
function setEnc(enc: EncodingId) {
  encoding = enc;
  singleByteDecoder =
    enc === "ascii" || enc === "utf-8" ? null : new TextDecoder(enc);
}

function asciiChar(b: number): string {
  return b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : ".";
}

async function readCharAt(
  idx: number,
): Promise<{ ch: string; len: number; nl: boolean }> {
  const b0 = await getByte(idx);
  if (b0 == null) return { ch: " ", len: 0, nl: true };
  if (b0 === 0x0a) return { ch: "\n", len: 1, nl: true };
  if (b0 === 0x0d)
    return {
      ch: "\n",
      len: (await getByte(idx + 1)) === 0x0a ? 2 : 1,
      nl: true,
    };
  if (b0 === 0x09) return { ch: "\t", len: 1, nl: false };
  if (encoding === "ascii") return { ch: asciiChar(b0), len: 1, nl: false };
  if (encoding === "utf-8") {
    if (b0 < 0x80) return { ch: String.fromCharCode(b0), len: 1, nl: false };
    let seqLen = 2;
    if (b0 >= 0xf0) seqLen = 4;
    else if (b0 >= 0xe0) seqLen = 3;
    const bytes = await peekBytes(idx, seqLen);
    try {
      const s = utf8Dec.decode(bytes);
      if (s.length > 0) return { ch: s, len: seqLen, nl: false };
    } catch {
      /* invalid sequence */
    }
    return { ch: "\ufffd", len: 1, nl: false };
  }
  if (!singleByteDecoder) singleByteDecoder = new TextDecoder(encoding);
  const s = singleByteDecoder.decode(new Uint8Array([b0]));
  return { ch: s || "\ufffd", len: 1, nl: false };
}

// ── Line finding ───────────────────────────────────────────────────────────────
async function findPrevLine(before: number): Promise<number> {
  if (before <= 0) return 0;
  let slen = 256;
  while (slen <= BACKWARD_SEARCH_MAX) {
    const s = Math.max(0, before - slen);
    const bytes = await readRange(s, before - s);
    for (let i = bytes.length - 2; i >= 0; i--)
      if (bytes[i] === 0x0a) return s + i + 1;
    if (s === 0) return 0;
    slen *= 2;
  }
  return 0;
}

// ── Text grid building ────────────────────────────────────────────────────────
async function buildLine(
  start: number,
  maxC: number,
  wrap: boolean,
  skip = 0,
): Promise<GridLine> {
  let out = "",
    col = 0,
    pos = start;
  const co: number[] = [];
  const total = wrap ? maxC : maxC + skip;

  while (col < total && pos < fileSize) {
    const r = await readCharAt(pos);
    if (r.len === 0) break;
    if (r.nl) {
      pos += r.len;
      break;
    }
    if (r.ch === "\t") {
      const sp = TAB_SIZE - (col % TAB_SIZE);
      for (let s = 0; s < sp && col < total; s++) {
        if (col >= skip) {
          out += " ";
          co.push(pos);
        }
        col++;
      }
      pos += r.len;
      continue;
    }
    if (col >= skip) {
      out += r.ch;
      co.push(pos);
    }
    col++;
    pos += r.len;
  }

  if (!wrap)
    while (pos < fileSize) {
      const b = await getByte(pos);
      if (b == null) break;
      if (b === 0x0a) {
        pos++;
        break;
      }
      if (b === 0x0d) {
        pos += (await getByte(pos + 1)) === 0x0a ? 2 : 1;
        break;
      }
      pos++;
    }

  while (out.length < maxC) {
    out += " ";
    co.push(-1);
  }
  return { text: out, byteStart: start, byteEnd: pos, charOffsets: co };
}

async function textGrid(): Promise<GridLine[]> {
  const lines: GridLine[] = [];
  let pos = dpyStart;
  const skip = wrapMode ? 0 : dpyTextColumn;

  if (wrapMode && dpyParagraphSkipLines > 0) {
    for (let i = 0; i < dpyParagraphSkipLines; i++) {
      const b = await buildLine(pos, cols, true);
      if (b.byteEnd === pos) break;
      pos = b.byteEnd;
      if (pos >= fileSize) break;
    }
  }
  for (let r = 0; r < rows; r++) {
    const b = await buildLine(pos, cols, wrapMode, skip);
    lines.push(b);
    pos = b.byteEnd;
    if (pos >= fileSize) break;
  }
  return lines;
}

// ── Hex grid building ──────────────────────────────────────────────────────────
function calcBPL(c: number): number {
  if (c < 26) return 4;
  return Math.max(4, 4 * Math.floor((c - 9) / (c <= 80 ? 17 : 18)));
}

function hlStyle(idx: number): string | undefined {
  if (hexMode && idx === hexCursor)
    return "background:var(--fg);color:var(--bg);";
  if (searchMatchStart >= 0 && idx >= searchMatchStart && idx < searchMatchEnd)
    return "background:var(--search-hl, #c6a800);color:var(--search-hl-fg, #000);";
  return undefined;
}

async function hexLineSegs(off: number): Promise<Seg[]> {
  const segs: Seg[] = [];
  const bytes: (number | null)[] = [];
  for (let i = 0; i < bytesPerLine; i++)
    bytes.push(off + i < fileSize ? await getByte(off + i) : null);

  // Offset
  segs.push({ text: hex8(off) + "  " });

  // Hex bytes
  for (let i = 0; i < bytesPerLine; i++) {
    if (i > 0 && i % 4 === 0) segs.push({ text: " " });
    const b = bytes[i];
    segs.push({
      text: b != null ? hex2(b) : "  ",
      style: b != null ? hlStyle(off + i) : undefined,
    });
    if (i < bytesPerLine - 1) segs.push({ text: " " });
  }

  // Separator + ASCII
  segs.push({ text: "  " });
  for (let i = 0; i < bytesPerLine; i++) {
    const b = bytes[i];
    segs.push({
      text: b != null ? asciiChar(b) : " ",
      style: b != null ? hlStyle(off + i) : undefined,
    });
  }
  return merge(segs);
}

function merge(segs: Seg[]): Seg[] {
  const m: Seg[] = [];
  for (const s of segs) {
    const l = m[m.length - 1];
    if (l && l.style === s.style) l.text += s.text;
    else m.push({ ...s });
  }
  return m;
}

// ── Text highlight segments ────────────────────────────────────────────────────
function textLineSegs(line: GridLine): Seg[] {
  if (searchMatchStart < 0) return [{ text: line.text }];
  const segs: Seg[] = [];
  let cur = "",
    curS: string | undefined;
  for (let i = 0; i < line.text.length; i++) {
    const bo = line.charOffsets[i]!;
    const hl =
      bo >= 0 && bo >= searchMatchStart && bo < searchMatchEnd
        ? "background:var(--search-hl, #c6a800);color:var(--search-hl-fg, #000);"
        : undefined;
    if (hl !== curS) {
      if (cur) segs.push({ text: cur, style: curS });
      cur = line.text[i]!;
      curS = hl;
    } else cur += line.text[i]!;
  }
  if (cur) segs.push({ text: cur, style: curS });
  return segs;
}

// ── Search ─────────────────────────────────────────────────────────────────────
function bytesEq(
  data: Uint8Array,
  off: number,
  q: Uint8Array,
  cs: boolean,
): boolean {
  for (let j = 0; j < q.length; j++) {
    let a = data[off + j]!,
      b = q[j]!;
    if (!cs) {
      if (a >= 0x41 && a <= 0x5a) a += 0x20;
      if (b >= 0x41 && b <= 0x5a) b += 0x20;
    }
    if (a !== b) return false;
  }
  return true;
}

async function searchFwd(
  from: number,
  q: Uint8Array,
  cs: boolean,
): Promise<number> {
  const ol = q.length - 1;
  let pos = from;
  while (pos < fileSize) {
    const len = Math.min(BLOCK_SIZE, fileSize - pos);
    const data = await readRange(pos, len);
    for (let i = 0; i <= data.length - q.length; i++)
      if (bytesEq(data, i, q, cs)) return pos + i;
    if (len < BLOCK_SIZE) break;
    pos += len - ol;
  }
  return -1;
}

async function searchBwd(
  from: number,
  q: Uint8Array,
  cs: boolean,
): Promise<number> {
  let hi = from;
  while (hi > 0) {
    const lo = Math.max(0, hi - BLOCK_SIZE);
    const readLen = Math.min(hi - lo + q.length - 1, fileSize - lo);
    const data = await readRange(lo, readLen);
    const maxI = Math.min(hi - 1 - lo, data.length - q.length);
    for (let i = maxI; i >= 0; i--) if (bytesEq(data, i, q, cs)) return lo + i;
    hi = lo;
  }
  return -1;
}

// ── Goto helper ────────────────────────────────────────────────────────────────
async function findLineOffset(lineNum: number): Promise<number> {
  let cur = 1,
    pos = 0;
  while (pos < fileSize && cur < lineNum) {
    const b = await getByte(pos);
    if (b == null) break;
    if (b === 0x0a) cur++;
    pos++;
  }
  return pos;
}

// ── Rendering helpers ──────────────────────────────────────────────────────────
function renderSegs(segs: Seg[], parent: HTMLElement) {
  const div = document.createElement("div");
  div.style.cssText = `white-space:pre;line-height:${LINE_HEIGHT_RATIO};height:${rowH}px;`;
  if (segs.length === 1 && !segs[0]!.style) {
    div.textContent = segs[0]!.text;
  } else {
    for (const s of segs) {
      if (s.style) {
        const sp = document.createElement("span");
        sp.style.cssText = s.style;
        sp.textContent = s.text;
        div.appendChild(sp);
      } else {
        div.appendChild(document.createTextNode(s.text));
      }
    }
  }
  parent.appendChild(div);
}

function updateThumb() {
  if (!scrollbarTrack || !scrollbarThumb) return;
  const tH = scrollbarTrack.clientHeight;
  if (tH <= 0 || fileSize <= 0) {
    scrollbarThumb.style.display = "none";
    return;
  }
  const vb = Math.max(1, rows * (hexMode ? bytesPerLine : cols));
  const th = Math.max(18, Math.floor((vb / Math.max(vb, fileSize)) * tH));
  const mx = Math.max(0, fileSize - vb);
  const p = mx === 0 ? 0 : dpyStart / mx;
  scrollbarThumb.style.height = `${th}px`;
  scrollbarThumb.style.top = `${Math.floor((tH - th) * Math.max(0, Math.min(1, p)))}px`;
  scrollbarThumb.style.display = "block";
}

function stopInertia() {
  if (inertiaFrame != null) {
    cancelAnimationFrame(inertiaFrame);
    inertiaFrame = null;
  }
  touchVelocity = 0;
}

// ── Mount ──────────────────────────────────────────────────────────────────────
export async function mountViewer(
  root: HTMLElement,
  props: ViewerProps,
): Promise<void> {
  _path = props.filePath;
  fileSize = props.fileSize;
  try {
    const stat = await dotdir.statFile(_path);
    fileSize = stat.size;
  } catch {
    // fall back to props.fileSize
  }
  dpyStart = 0;
  wrapMode = true;
  dpyParagraphSkipLines = 0;
  dpyTextColumn = 0;
  hexMode = false;
  hexCursor = 0;
  cacheOff = -1;
  cacheBuf = null;
  cacheLen = 0;
  searchMatchStart = -1;
  searchMatchEnd = -1;
  searchQuery = "";
  inputBarMode = null;
  setEnc("ascii");

  // Cleanup previous
  disposeCommands();
  if (inputKeydownHandler && inputBarInput) {
    inputBarInput.removeEventListener("keydown", inputKeydownHandler);
    inputKeydownHandler = null;
  }
  if (resizeHandler) window.removeEventListener("resize", resizeHandler);
  if (wheelHandler && frameDiv)
    frameDiv.removeEventListener("wheel", wheelHandler);
  if (ptrMoveHandler) window.removeEventListener("pointermove", ptrMoveHandler);
  if (ptrUpHandler) window.removeEventListener("pointerup", ptrUpHandler);
  stopInertia();

  // Re-subscribe to external file changes
  if (disposeFileChange) {
    disposeFileChange();
    disposeFileChange = null;
  }
  disposeFileChange = dotdir.onFileChange(async () => {
    // Reset cache and redisplay when file changes on disk
    if (dotdir.statFile) {
      try {
        const stat = await dotdir.statFile(_path);
        fileSize = stat.size;
      } catch {
        // ignore stat errors, keep old size
      }
    }
    cacheOff = -1;
    cacheBuf = null;
    cacheLen = 0;
    dpyStart = clamp(dpyStart);
    // await redraw();
  });

  // ── DOM ──
  root.innerHTML = "";
  root.style.cssText =
    "margin:0;padding:0;height:100%;display:flex;flex-direction:column;overflow:hidden;";

  // Header
  const hdr = document.createElement("div");
  hdr.style.cssText =
    "display:flex;align-items:center;gap:8px;padding:4px 8px;border-bottom:1px solid var(--border);background:var(--bg-secondary);color:var(--fg);font:12px system-ui,-apple-system,sans-serif;";
  root.appendChild(hdr);

  const nameEl = document.createElement("div");
  nameEl.style.cssText =
    "flex:1;color:var(--fg-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
  nameEl.textContent = `${props.fileName} \u2014 ${fmtBytes(fileSize)}`;
  hdr.appendChild(nameEl);

  hexBtn = document.createElement("button");
  hexBtn.style.cssText =
    "border:1px solid var(--border);background:var(--bg);color:var(--fg);border-radius:4px;padding:2px 8px;font-size:11px;cursor:pointer;";
  hexBtn.textContent = "Hex";
  hexBtn.title = "Toggle hex mode";
  hdr.appendChild(hexBtn);

  const wl = document.createElement("label");
  wl.style.cssText =
    "display:flex;align-items:center;gap:4px;color:var(--fg-muted);user-select:none;font-size:11px;";
  wrapChk = document.createElement("input");
  wrapChk.type = "checkbox";
  wrapChk.checked = wrapMode;
  wrapChk.style.cssText = "accent-color:var(--action-bar-fg);";
  wl.appendChild(wrapChk);
  wl.appendChild(document.createTextNode("Wrap"));
  wl.title = "Toggle wrap (F2)";
  hdr.appendChild(wl);

  const sel = document.createElement("select");
  sel.style.cssText =
    "border:1px solid var(--border);background:var(--bg);color:var(--fg);border-radius:4px;padding:2px 6px;font-size:11px;";
  const encs: { id: EncodingId; label: string }[] = [
    { id: "ascii", label: "ASCII" },
    { id: "utf-8", label: "UTF-8" },
    { id: "windows-1251", label: "Win-1251" },
    { id: "koi8-r", label: "KOI8-R" },
    { id: "iso-8859-1", label: "ISO-8859-1" },
  ];
  for (const { id, label } of encs) {
    const o = document.createElement("option");
    o.value = id;
    o.textContent = label;
    sel.appendChild(o);
  }
  sel.value = encoding;
  hdr.appendChild(sel);

  // Frame
  const frame = document.createElement("div");
  frame.style.cssText =
    "flex:1;min-height:0;position:relative;overflow:hidden;background:var(--bg);";
  frame.tabIndex = 0;
  frameDiv = frame;
  root.appendChild(frame);

  contentDiv = document.createElement("div");
  contentDiv.style.cssText = `position:absolute;left:8px;top:4px;right:${8 + SCROLLBAR_WIDTH + SCROLLBAR_PADDING}px;bottom:4px;overflow:hidden;font:12px/1 ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;color:var(--fg);`;
  frame.appendChild(contentDiv);

  scrollbarTrack = document.createElement("div");
  scrollbarTrack.style.cssText = `position:absolute;top:8px;bottom:8px;right:8px;width:${SCROLLBAR_WIDTH}px;border-radius:999px;background:var(--bg-secondary);border:1px solid var(--border);`;
  frame.appendChild(scrollbarTrack);

  scrollbarThumb = document.createElement("div");
  scrollbarThumb.style.cssText =
    "position:absolute;left:1px;right:1px;top:1px;height:20px;border-radius:999px;background:var(--entry-selected);border:1px solid var(--border-active);";
  scrollbarTrack.appendChild(scrollbarThumb);

  // Input bar (search/goto)
  inputBarDiv = document.createElement("div");
  inputBarDiv.style.cssText =
    "display:none;position:absolute;left:0;right:0;bottom:0;background:var(--bg-secondary);border-top:1px solid var(--border);padding:4px 8px;font:12px system-ui,sans-serif;color:var(--fg);align-items:center;gap:6px;z-index:10;";
  frame.appendChild(inputBarDiv);

  inputBarLabel = document.createElement("span");
  inputBarLabel.style.cssText = "color:var(--fg-muted);font-size:11px;";
  inputBarLabel.textContent = "Search:";
  inputBarDiv.appendChild(inputBarLabel);

  inputBarInput = document.createElement("input");
  inputBarInput.type = "text";
  inputBarInput.style.cssText =
    "flex:1;border:1px solid var(--border);background:var(--bg);color:var(--fg);border-radius:4px;padding:2px 6px;font:12px ui-monospace,monospace;min-width:80px;";
  inputBarDiv.appendChild(inputBarInput);

  const caseLabel = document.createElement("label");
  caseLabel.style.cssText =
    "display:flex;align-items:center;gap:3px;color:var(--fg-muted);user-select:none;font-size:11px;";
  inputBarCase = document.createElement("input");
  inputBarCase.type = "checkbox";
  inputBarCase.checked = searchCaseSensitive;
  caseLabel.appendChild(inputBarCase);
  caseLabel.appendChild(document.createTextNode("Case"));
  inputBarDiv.appendChild(caseLabel);

  inputBarStatus = document.createElement("span");
  inputBarStatus.style.cssText = "color:var(--fg-muted);font-size:11px;";
  inputBarDiv.appendChild(inputBarStatus);

  // Status bar
  statusDiv = document.createElement("div");
  statusDiv.style.cssText =
    "padding:2px 8px;border-top:1px solid var(--border);background:var(--bg-secondary);color:var(--fg-muted);font:11px ui-monospace,monospace;white-space:nowrap;overflow:hidden;";
  root.appendChild(statusDiv);

  // ── Measure ──
  const measure = () => {
    if (!contentDiv) return;
    const probe = document.createElement("span");
    probe.textContent = "M";
    probe.style.cssText =
      "visibility:hidden;position:absolute;left:-10000px;top:-10000px;";
    contentDiv.appendChild(probe);
    const r = probe.getBoundingClientRect();
    contentDiv.removeChild(probe);
    charW = Math.max(6, r.width || 8);
    charH = Math.max(10, r.height || 16);
    rowH = Math.max(15, Math.round(charH * LINE_HEIGHT_RATIO));
    cols = Math.max(10, Math.floor(contentDiv.clientWidth / charW));
    rows = Math.max(1, Math.floor(contentDiv.clientHeight / rowH));
    if (hexMode) bytesPerLine = calcBPL(cols);
  };

  // ── Render ──
  const render = async () => {
    if (!contentDiv) return;
    contentDiv.innerHTML = "";

    if (hexMode) {
      let pos = dpyStart;
      for (let r = 0; r < rows && pos < fileSize; r++) {
        renderSegs(await hexLineSegs(pos), contentDiv);
        pos += bytesPerLine;
      }
      lastEndByte = Math.min(pos, fileSize);
    } else {
      const grid = await textGrid();
      for (const line of grid) renderSegs(textLineSegs(line), contentDiv);
      lastEndByte = grid.length > 0 ? grid[grid.length - 1]!.byteEnd : dpyStart;
    }
    updateThumb();
    updateStatus();
  };

  const updateStatus = () => {
    if (!statusDiv) return;
    const pct =
      fileSize > 0
        ? Math.min(100, Math.floor((lastEndByte / fileSize) * 100))
        : 100;
    if (hexMode) {
      statusDiv.textContent = `Hex  0x${hex8(hexCursor)}  ${hexCursor}/${fileSize}  [${encoding.toUpperCase()}]  ${pct}%`;
    } else {
      let s = `${dpyStart}/${fileSize}`;
      if (!wrapMode && dpyTextColumn > 0) s += `  Col:${dpyTextColumn}`;
      s += `  [${encoding.toUpperCase()}]  ${pct}%`;
      statusDiv.textContent = s;
    }
  };

  // ── Scrolling ──
  const hexScrollToCursor = () => {
    const curRow = Math.floor(hexCursor / bytesPerLine);
    const startRow = Math.floor(dpyStart / bytesPerLine);
    if (curRow < startRow) dpyStart = curRow * bytesPerLine;
    else if (curRow >= startRow + rows)
      dpyStart = (curRow - rows + 1) * bytesPerLine;
    dpyStart = Math.max(0, dpyStart);
  };

  const scrollDown = async (n: number) => {
    if (hexMode) {
      hexCursor = clamp(hexCursor + n * bytesPerLine);
      hexScrollToCursor();
      await render();
      return;
    }
    if (!wrapMode) {
      let pos = dpyStart;
      for (let i = 0; i < n; i++) {
        const b = await buildLine(pos, cols, false, dpyTextColumn);
        if (b.byteEnd === pos) break;
        pos = b.byteEnd;
        if (pos >= fileSize) break;
      }
      dpyStart = clamp(pos);
      await render();
      return;
    }
    // Wrap mode
    let pos = dpyStart,
      skip = dpyParagraphSkipLines;
    for (let i = 0; i < n; i++) {
      const b = await buildLine(pos, cols, true);
      if (b.byteEnd === pos) break;
      const lb = await getByte(b.byteEnd - 1);
      if (lb === 0x0a || lb === 0x0d) {
        pos = b.byteEnd;
        dpyStart = clamp(pos);
        skip = 0;
        dpyParagraphSkipLines = 0;
      } else {
        skip++;
        dpyParagraphSkipLines = skip;
      }
      pos = b.byteEnd;
      if (pos >= fileSize) break;
    }
    await render();
  };

  const scrollUp = async (n: number) => {
    if (hexMode) {
      hexCursor = Math.max(0, hexCursor - n * bytesPerLine);
      hexScrollToCursor();
      await render();
      return;
    }
    if (!wrapMode) {
      let pos = dpyStart;
      for (let i = 0; i < n; i++) {
        pos = await findPrevLine(pos);
        if (pos === 0) break;
      }
      dpyStart = clamp(pos);
      await render();
      return;
    }
    for (let i = 0; i < n; i++) {
      if (dpyParagraphSkipLines > 0) {
        dpyParagraphSkipLines--;
        continue;
      }
      dpyStart = clamp(await findPrevLine(dpyStart));
      let pos = dpyStart,
        count = 0;
      for (let g = 0; g < 5000; g++) {
        const b = await buildLine(pos, cols, true);
        if (b.byteEnd === pos) break;
        const lb = await getByte(b.byteEnd - 1);
        if (lb === 0x0a || lb === 0x0d) break;
        pos = b.byteEnd;
        count++;
      }
      dpyParagraphSkipLines = Math.max(0, count);
    }
    await render();
  };

  const scrollLeft = async (n: number) => {
    if (hexMode || wrapMode) return;
    dpyTextColumn = Math.max(0, dpyTextColumn - n);
    await render();
  };

  const scrollRight = async (n: number) => {
    if (hexMode || wrapMode) return;
    dpyTextColumn += n;
    await render();
  };

  const jumpToRatio = async (ratio: number) => {
    if (hexMode) {
      hexCursor = clamp(Math.floor(ratio * Math.max(0, fileSize - 1)));
      dpyStart = Math.floor(hexCursor / bytesPerLine) * bytesPerLine;
    } else {
      const next = clamp(Math.floor(ratio * Math.max(0, fileSize - 1)));
      dpyStart = await findPrevLine(next);
      dpyParagraphSkipLines = 0;
    }
    await render();
  };

  // ── Search actions ──
  const doSearch = async (dir: "forward" | "backward") => {
    if (!searchQuery) return;
    const q = new TextEncoder().encode(searchQuery);
    if (q.length === 0) return;
    const cs = searchCaseSensitive;
    const cur = hexMode ? hexCursor : dpyStart;
    let result: number;

    if (dir === "forward") {
      const from = searchMatchStart >= 0 ? searchMatchStart + 1 : cur;
      result = await searchFwd(from, q, cs);
      if (result < 0 && from > 0) result = await searchFwd(0, q, cs); // wrap
    } else {
      const from = searchMatchStart >= 0 ? searchMatchStart : cur;
      result = await searchBwd(from, q, cs);
      if (result < 0) result = await searchBwd(fileSize, q, cs); // wrap
    }

    if (result >= 0) {
      searchMatchStart = result;
      searchMatchEnd = result + q.length;
      if (hexMode) {
        hexCursor = result;
        hexScrollToCursor();
      } else {
        dpyStart = await findPrevLine(result);
        dpyParagraphSkipLines = 0;
      }
      if (inputBarStatus) inputBarStatus.textContent = "";
    } else {
      searchMatchStart = -1;
      searchMatchEnd = -1;
      if (inputBarStatus) inputBarStatus.textContent = "Not found";
    }
    lastSearchDir = dir;
    await render();
  };

  const doGoto = async (input: string) => {
    const t = input.trim();
    if (!t) return;
    let off: number;
    if (t.startsWith(":")) {
      const ln = parseInt(t.slice(1), 10);
      if (isNaN(ln) || ln < 1) return;
      off = await findLineOffset(ln);
    } else if (t.endsWith("%")) {
      const pct = parseFloat(t.slice(0, -1));
      if (isNaN(pct)) return;
      off = Math.floor((Math.max(0, Math.min(100, pct)) / 100) * fileSize);
    } else if (t.startsWith("0x") || t.startsWith("0X")) {
      off = parseInt(t, 16);
      if (isNaN(off)) return;
    } else {
      off = parseInt(t, 10);
      if (isNaN(off)) return;
    }
    off = clamp(off);
    if (hexMode) {
      hexCursor = off;
      hexScrollToCursor();
    } else {
      dpyStart = await findPrevLine(off);
      dpyParagraphSkipLines = 0;
      dpyTextColumn = 0;
    }
    hideBar();
    await render();
  };

  // ── Input bar ──
  const showBar = (mode: "search" | "goto") => {
    inputBarMode = mode;
    if (inputBarDiv) inputBarDiv.style.display = "flex";
    if (inputBarLabel)
      inputBarLabel.textContent = mode === "search" ? "Search:" : "Go to:";
    if (inputBarInput) {
      inputBarInput.value = mode === "search" ? searchQuery : "";
      inputBarInput.placeholder =
        mode === "goto" ? "offset, 0xHEX, NN%, :line" : "";
      inputBarInput.focus();
      inputBarInput.select();
    }
    if (inputBarStatus) inputBarStatus.textContent = "";
    if (inputBarCase)
      (inputBarCase.parentElement as HTMLElement).style.display =
        mode === "search" ? "flex" : "none";
  };

  const hideBar = () => {
    inputBarMode = null;
    if (inputBarDiv) inputBarDiv.style.display = "none";
    frameDiv?.focus();
  };

  const closeViewer = () => {
    dotdir.onClose();
  };

  const scrollLineDown = async () => {
    await scrollDown(1);
  };

  const scrollLineUp = async () => {
    await scrollUp(1);
  };

  const scrollViewerLeft = async () => {
    if (hexMode) {
      hexCursor = Math.max(0, hexCursor - 1);
      hexScrollToCursor();
      await render();
      return;
    }
    await scrollLeft(1);
  };

  const scrollViewerRight = async () => {
    if (hexMode) {
      hexCursor = clamp(hexCursor + 1);
      hexScrollToCursor();
      await render();
      return;
    }
    await scrollRight(1);
  };

  const scrollPageDown = async () => {
    await scrollDown(rows);
  };

  const scrollPageUp = async () => {
    await scrollUp(rows);
  };

  const scrollToStart = async () => {
    if (hexMode) {
      hexCursor = 0;
      dpyStart = 0;
    } else {
      dpyStart = 0;
      dpyParagraphSkipLines = 0;
      dpyTextColumn = 0;
    }
    await render();
  };

  const scrollToEnd = async () => {
    await jumpToRatio(1);
  };

  const toggleWrap = async () => {
    if (!wrapChk) return;
    wrapChk.checked = !wrapChk.checked;
    wrapChk.dispatchEvent(new Event("change"));
  };

  const toggleHex = async () => {
    hexBtn?.click();
  };

  const openGoto = async () => {
    showBar("goto");
  };

  const openSearch = async () => {
    showBar("search");
  };

  const searchNext = async () => {
    if (searchQuery) await doSearch("forward");
    else showBar("search");
  };

  const searchPrevious = async () => {
    if (searchQuery) await doSearch("backward");
    else showBar("search");
  };

  // ── Event handlers ──
  measure();

  sel.addEventListener("change", async () => {
    setEnc(sel.value as EncodingId);
    await render();
  });

  hexBtn.addEventListener("click", async () => {
    hexMode = !hexMode;
    if (hexMode) {
      hexCursor = dpyStart;
      bytesPerLine = calcBPL(cols);
      dpyStart = Math.floor(hexCursor / bytesPerLine) * bytesPerLine;
    } else {
      dpyStart = await findPrevLine(hexCursor);
      dpyParagraphSkipLines = 0;
      dpyTextColumn = 0;
    }
    hexBtn!.style.background = hexMode ? "var(--entry-selected)" : "var(--bg)";
    await render();
  });

  wrapChk.addEventListener("change", async () => {
    wrapMode = wrapChk!.checked;
    dpyParagraphSkipLines = 0;
    dpyTextColumn = 0;
    if (wrapMode) dpyStart = await findPrevLine(dpyStart);
    await render();
  });

  if (inputBarCase)
    inputBarCase.addEventListener("change", () => {
      searchCaseSensitive = inputBarCase!.checked;
    });

  const commands = dotdir.commands;
  if (!commands) throw new Error("Host commands API is unavailable");
  disposeCommands();
  commandDisposers = [
    commands.registerCommand("fileViewer.close", closeViewer),
    commands.registerCommand("fileViewer.scrollLineDown", scrollLineDown),
    commands.registerCommand("fileViewer.scrollLineUp", scrollLineUp),
    commands.registerCommand("fileViewer.scrollLeft", scrollViewerLeft),
    commands.registerCommand("fileViewer.scrollRight", scrollViewerRight),
    commands.registerCommand("fileViewer.scrollPageDown", scrollPageDown),
    commands.registerCommand("fileViewer.scrollPageUp", scrollPageUp),
    commands.registerCommand("fileViewer.scrollToStart", scrollToStart),
    commands.registerCommand("fileViewer.scrollToEnd", scrollToEnd),
    commands.registerCommand("fileViewer.toggleWrap", toggleWrap),
    commands.registerCommand("fileViewer.toggleHex", toggleHex),
    commands.registerCommand("fileViewer.openGoto", openGoto),
    commands.registerCommand("fileViewer.openSearch", openSearch),
    commands.registerCommand("fileViewer.searchNext", searchNext),
    commands.registerCommand("fileViewer.searchPrevious", searchPrevious),
  ];

  // Wheel
  wheelHandler = (e: WheelEvent) => {
    e.preventDefault();
    const lines = Math.round(e.deltaY / rowH);
    if (lines > 0) void scrollDown(Math.max(1, lines));
    else if (lines < 0) void scrollUp(Math.max(1, -lines));
  };
  frame.addEventListener("wheel", wheelHandler, { passive: false });

  // Touch
  frame.addEventListener("pointerdown", (e: PointerEvent) => {
    if (e.pointerType !== "touch") return;
    stopInertia();
    lastTouchY = e.clientY;
    lastTouchTime = performance.now();
  });
  frame.addEventListener("pointermove", (e: PointerEvent) => {
    if (e.pointerType !== "touch" || lastTouchTime === 0) return;
    const now = performance.now(),
      dy = e.clientY - lastTouchY,
      dt = now - lastTouchTime || 1;
    const lines = dy / rowH;
    if (lines > 0) void scrollUp(Math.max(1, Math.round(lines)));
    else if (lines < 0) void scrollDown(Math.max(1, Math.round(-lines)));
    touchVelocity = dy / dt;
    lastTouchY = e.clientY;
    lastTouchTime = now;
  });
  frame.addEventListener("pointerup", (e: PointerEvent) => {
    if (e.pointerType !== "touch") return;
    lastTouchTime = 0;
    stopInertia();
    if (Math.abs(touchVelocity) < 0.01) return;
    const step = async () => {
      if (Math.abs(touchVelocity) < 0.01) {
        stopInertia();
        return;
      }
      const px = touchVelocity * 16,
        lines = px / rowH;
      if (lines > 0) await scrollDown(Math.max(1, Math.round(lines)));
      else if (lines < 0) await scrollUp(Math.max(1, Math.round(-lines)));
      touchVelocity *= 0.95;
      inertiaFrame = requestAnimationFrame(() => void step());
    };
    inertiaFrame = requestAnimationFrame(() => void step());
  });

  // Scrollbar
  scrollbarThumb.addEventListener("pointerdown", (e: PointerEvent) => {
    if (!scrollbarThumb) return;
    dragging = true;
    dragOffsetY = e.clientY - scrollbarThumb.getBoundingClientRect().top;
    e.preventDefault();
  });
  scrollbarTrack.addEventListener("pointerdown", (e: PointerEvent) => {
    if (!scrollbarTrack || !scrollbarThumb) return;
    const rect = scrollbarTrack.getBoundingClientRect();
    const y = e.clientY - rect.top,
      th = scrollbarThumb.clientHeight;
    void jumpToRatio(
      Math.max(0, Math.min(1, (y - th / 2) / Math.max(1, rect.height - th))),
    );
    e.preventDefault();
  });

  ptrMoveHandler = (e: PointerEvent) => {
    if (!dragging || !scrollbarTrack || !scrollbarThumb) return;
    const rect = scrollbarTrack.getBoundingClientRect(),
      th = scrollbarThumb.clientHeight;
    void jumpToRatio(
      Math.max(
        0,
        Math.min(
          1,
          (e.clientY - rect.top - dragOffsetY) / Math.max(1, rect.height - th),
        ),
      ),
    );
  };
  window.addEventListener("pointermove", ptrMoveHandler);
  ptrUpHandler = () => {
    dragging = false;
  };
  window.addEventListener("pointerup", ptrUpHandler);

  inputKeydownHandler = (e: KeyboardEvent) => {
    if (!inputBarInput || document.activeElement !== inputBarInput) return;
    if (e.key === "Escape") {
      e.preventDefault();
      hideBar();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (inputBarMode === "search") {
        searchQuery = inputBarInput.value;
        void doSearch(e.shiftKey ? "backward" : "forward");
      } else if (inputBarMode === "goto") {
        void doGoto(inputBarInput.value);
      }
    }
  };
  inputBarInput?.addEventListener("keydown", inputKeydownHandler);

  resizeHandler = () => {
    measure();
    if (wrapMode) dpyParagraphSkipLines = 0; // prevent stale skip after column change
    void render();
  };
  window.addEventListener("resize", resizeHandler);

  await render();
}

// ── Unmount ────────────────────────────────────────────────────────────────────
export function unmountViewer(): void {
  stopInertia();
  disposeCommands();
  if (inputKeydownHandler && inputBarInput) {
    inputBarInput.removeEventListener("keydown", inputKeydownHandler);
    inputKeydownHandler = null;
  }
  if (resizeHandler) {
    window.removeEventListener("resize", resizeHandler);
    resizeHandler = null;
  }
  if (wheelHandler && frameDiv)
    frameDiv.removeEventListener("wheel", wheelHandler);
  wheelHandler = null;
  if (ptrMoveHandler) {
    window.removeEventListener("pointermove", ptrMoveHandler);
    ptrMoveHandler = null;
  }
  if (ptrUpHandler) {
    window.removeEventListener("pointerup", ptrUpHandler);
    ptrUpHandler = null;
  }
  frameDiv = null;
  contentDiv = null;
  statusDiv = null;
  scrollbarTrack = null;
  scrollbarThumb = null;
  inputBarDiv = null;
  inputBarInput = null;
  inputBarLabel = null;
  inputBarStatus = null;
  inputBarCase = null;
  hexBtn = null;
  wrapChk = null;
}
