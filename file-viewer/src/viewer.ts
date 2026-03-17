import type { ViewerProps, HostApi } from './types';

const SCROLLBAR_WIDTH = 10;
const SCROLLBAR_PADDING = 6;
const TAB_SIZE = 8;
const BLOCK_SIZE = 64 * 1024;
const BACKWARD_SEARCH_INITIAL = 256;
const BACKWARD_SEARCH_MAX = 8192;

type EncodingId = 'ascii' | 'utf-8' | 'windows-1251' | 'koi8-r' | 'iso-8859-1';

interface ScreenLine {
  text: string;
  byteStart: number;
  byteEnd: number;
}

let rootEl: HTMLDivElement | null = null;
let keydownHandler: ((e: KeyboardEvent) => void) | null = null;
let resizeHandler: (() => void) | null = null;
let wheelHandler: ((e: WheelEvent) => void) | null = null;
let pointerMoveHandler: ((e: PointerEvent) => void) | null = null;
let pointerUpHandler: ((e: PointerEvent) => void) | null = null;
let inertiaFrame: number | null = null;
let lastTouchY = 0;
let lastTouchTime = 0;
let touchVelocity = 0;

let fileSize = 0;
let dpyStart = 0; // byte offset of top-left corner (MC-style)
let wrapMode = true; // default to wrap (MC-style char-wrap)
let dpyParagraphSkipLines = 0; // only used in wrap mode (MC-style)

let frameDiv: HTMLDivElement | null = null;
let contentDiv: HTMLDivElement | null = null;
let headerDiv: HTMLDivElement | null = null;
let scrollbarTrack: HTMLDivElement | null = null;
let scrollbarThumb: HTMLDivElement | null = null;

let dragging = false;
let dragOffsetY = 0;

let charW = 8;
let charH = 16;
let rows = 20;
let cols = 80;

let encoding: EncodingId = 'ascii';
let singleByteDecoder: TextDecoder | null = null;
const utf8DecoderFatal = new TextDecoder('utf-8', { fatal: true });

// MC-like "datasource": a single cached block.
let cachedBlockOffset = -1;
let cachedBlock: Uint8Array | null = null;
let cachedBlockLen = 0;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

async function readRange(hostApi: HostApi, path: string, offset: number, length: number): Promise<Uint8Array> {
  if (hostApi.readFileRange) {
    const buf = await hostApi.readFileRange(path, offset, length);
    return new Uint8Array(buf);
  }
  const buf = await hostApi.readFile(path);
  const arr = new Uint8Array(buf);
  const end = Math.min(offset + length, arr.length);
  return arr.subarray(offset, end);
}

async function loadBlock(hostApi: HostApi, path: string, byteIndex: number): Promise<void> {
  const blockOffset = Math.max(0, Math.min(fileSize, Math.floor(byteIndex / BLOCK_SIZE) * BLOCK_SIZE));
  if (cachedBlock && cachedBlockOffset === blockOffset) return;
  const bytes = await readRange(hostApi, path, blockOffset, BLOCK_SIZE);
  cachedBlockOffset = blockOffset;
  cachedBlock = bytes;
  cachedBlockLen = bytes.length;
}

async function getByte(hostApi: HostApi, path: string, byteIndex: number): Promise<number | null> {
  if (byteIndex < 0 || byteIndex >= fileSize) return null;
  await loadBlock(hostApi, path, byteIndex);
  if (!cachedBlock) return null;
  const i = byteIndex - cachedBlockOffset;
  if (i < 0 || i >= cachedBlockLen) return null;
  return cachedBlock[i]!;
}

async function peekBytes(hostApi: HostApi, path: string, byteIndex: number, maxLen: number): Promise<Uint8Array> {
  const out = new Uint8Array(Math.min(maxLen, Math.max(0, fileSize - byteIndex)));
  for (let i = 0; i < out.length; i++) {
    const b = await getByte(hostApi, path, byteIndex + i);
    if (b == null) return out.subarray(0, i);
    out[i] = b;
  }
  return out;
}

async function findPrevLineStart(hostApi: HostApi, path: string, beforeByte: number): Promise<number> {
  if (beforeByte <= 0) return 0;
  let searchLen = BACKWARD_SEARCH_INITIAL;
  while (searchLen <= BACKWARD_SEARCH_MAX) {
    const start = Math.max(0, beforeByte - searchLen);
    const len = beforeByte - start;
    const bytes = await readRange(hostApi, path, start, len);
    for (let i = bytes.length - 2; i >= 0; i--) {
      if (bytes[i] === 0x0a) return start + i + 1;
    }
    if (start === 0) return 0;
    searchLen *= 2;
  }
  return 0;
}

function setEncoding(enc: EncodingId) {
  encoding = enc;
  if (enc === 'ascii' || enc === 'utf-8') {
    singleByteDecoder = null;
    return;
  }
  singleByteDecoder = new TextDecoder(enc);
}

function asciiCharForByte(b: number): string {
  // MC-ish: printable ASCII stays, control chars become '.'.
  if (b >= 0x20 && b <= 0x7e) return String.fromCharCode(b);
  return '.';
}

async function readCharAt(hostApi: HostApi, path: string, byteIndex: number): Promise<{ ch: string; len: number; isNewline: boolean }> {
  const b0 = await getByte(hostApi, path, byteIndex);
  if (b0 == null) return { ch: ' ', len: 0, isNewline: true };

  // Handle CRLF / LF
  if (b0 === 0x0a) return { ch: '\n', len: 1, isNewline: true };
  if (b0 === 0x0d) {
    const b1 = await getByte(hostApi, path, byteIndex + 1);
    if (b1 === 0x0a) return { ch: '\n', len: 2, isNewline: true };
    return { ch: '\n', len: 1, isNewline: true };
  }

  if (encoding === 'ascii') {
    if (b0 === 0x09) return { ch: '\t', len: 1, isNewline: false };
    return { ch: asciiCharForByte(b0), len: 1, isNewline: false };
  }

  if (encoding === 'utf-8') {
    // MC-style: try to decode a valid UTF-8 sequence; on failure fall back to a single byte.
    const bytes = await peekBytes(hostApi, path, byteIndex, 4);
    for (let n = Math.min(4, bytes.length); n >= 1; n--) {
      try {
        const s = utf8DecoderFatal.decode(bytes.subarray(0, n));
        if (s.length > 0) return { ch: s[0]!, len: n, isNewline: false };
      } catch {
        // try shorter
      }
    }
    return { ch: '�', len: 1, isNewline: false };
  }

  // Single-byte encodings
  if (!singleByteDecoder) singleByteDecoder = new TextDecoder(encoding);
  const s = singleByteDecoder.decode(new Uint8Array([b0]));
  return { ch: s.length ? s : '�', len: 1, isNewline: false };
}

async function buildGridLine(
  hostApi: HostApi,
  path: string,
  startByte: number,
  maxCols: number,
  wrap: boolean
): Promise<{ line: string; byteStart: number; byteEnd: number }> {
  let out = '';
  let col = 0;
  let pos = startByte;

  while (col < maxCols && pos < fileSize) {
    const r = await readCharAt(hostApi, path, pos);
    if (r.len === 0) break;

    if (r.isNewline) {
      pos += r.len;
      break;
    }

    if (r.ch === '\t') {
      const spaces = TAB_SIZE - (col % TAB_SIZE);
      const n = Math.min(spaces, maxCols - col);
      out += ' '.repeat(n);
      col += n;
      pos += r.len;
      continue;
    }

    // For now, treat each JS code unit as width 1; aligns with monospace in most cases.
    out += r.ch;
    col += 1;
    pos += r.len;
  }

  // Unwrap mode: consume the remainder of the physical line (including newline),
  // even if it doesn't fit on screen (MC behavior).
  if (!wrap) {
    while (pos < fileSize) {
      const b = await getByte(hostApi, path, pos);
      if (b == null) break;
      if (b === 0x0a) {
        pos += 1;
        break;
      }
      if (b === 0x0d) {
        const b1 = await getByte(hostApi, path, pos + 1);
        pos += b1 === 0x0a ? 2 : 1;
        break;
      }
      pos += 1;
    }
  }

  if (out.length < maxCols) out = out + ' '.repeat(maxCols - out.length);
  return { line: out, byteStart: startByte, byteEnd: pos };
}

async function renderGrid(hostApi: HostApi, props: ViewerProps): Promise<ScreenLine[]> {
  const lines: ScreenLine[] = [];
  let pos = dpyStart;

  // Wrap mode: dpyStart is paragraph start; skip some wrapped rows within that paragraph.
  if (wrapMode && dpyParagraphSkipLines > 0) {
    for (let i = 0; i < dpyParagraphSkipLines; i++) {
      const built = await buildGridLine(hostApi, props.filePath, pos, cols, true);
      if (built.byteEnd === pos) break;
      pos = built.byteEnd;
      if (pos >= fileSize) break;
    }
  }

  for (let r = 0; r < rows; r++) {
    const built = await buildGridLine(hostApi, props.filePath, pos, cols, wrapMode);
    lines.push({ text: built.line, byteStart: built.byteStart, byteEnd: built.byteEnd });
    pos = built.byteEnd;
    if (pos >= fileSize) break;
  }
  return lines;
}

function updateScrollbarThumb(): void {
  if (!scrollbarTrack || !scrollbarThumb) return;
  const trackH = scrollbarTrack.clientHeight;
  if (trackH <= 0 || fileSize <= 0) {
    scrollbarThumb.style.display = 'none';
    return;
  }
  const viewBytes = Math.max(1, rows * cols); // rough, but stable
  const thumbMin = 18;
  const thumbH = Math.max(thumbMin, Math.floor((viewBytes / Math.max(viewBytes, fileSize)) * trackH));
  const maxTop = Math.max(0, fileSize - viewBytes);
  const progress = maxTop === 0 ? 0 : dpyStart / maxTop;
  const thumbY = Math.floor((trackH - thumbH) * Math.max(0, Math.min(1, progress)));
  scrollbarThumb.style.height = `${thumbH}px`;
  scrollbarThumb.style.top = `${thumbY}px`;
  scrollbarThumb.style.display = 'block';
}

function clampDpyStart(next: number): number {
  if (fileSize <= 0) return 0;
  return Math.max(0, Math.min(next, Math.max(0, fileSize - 1)));
}

export async function mountViewer(root: HTMLElement, hostApi: HostApi, props: ViewerProps): Promise<void> {
  fileSize = props.fileSize;
  dpyStart = 0;
  wrapMode = true;
  dpyParagraphSkipLines = 0;
  cachedBlockOffset = -1;
  cachedBlock = null;
  cachedBlockLen = 0;
  setEncoding('ascii');

  root.innerHTML = '';
  root.style.margin = '0';
  root.style.padding = '0';
  root.style.height = '100%';
  root.style.display = 'flex';
  root.style.flexDirection = 'column';
  root.style.overflow = 'hidden';

  // Header (encoding selector)
  headerDiv = document.createElement('div');
  headerDiv.style.cssText =
    'display:flex;align-items:center;gap:10px;padding:8px 10px;border-bottom:1px solid var(--border);background:var(--bg-secondary);color:var(--fg);font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:12px;';
  root.appendChild(headerDiv);

  const size = document.createElement('div');
  size.style.cssText = 'flex:1;min-width:0;color:var(--fg-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
  size.textContent = formatBytes(props.fileSize);
  headerDiv.appendChild(size);

  const encLabel = document.createElement('div');
  encLabel.style.cssText = 'color:var(--fg-muted);';
  encLabel.textContent = 'Encoding';
  headerDiv.appendChild(encLabel);

  const wrapLabel = document.createElement('label');
  wrapLabel.style.cssText = 'display:flex;align-items:center;gap:6px;color:var(--fg-muted);user-select:none;';
  const wrapToggle = document.createElement('input');
  wrapToggle.type = 'checkbox';
  wrapToggle.checked = wrapMode;
  wrapToggle.style.cssText = 'accent-color: var(--action-bar-fg);';
  const wrapText = document.createElement('span');
  wrapText.textContent = 'Wrap';
  wrapLabel.appendChild(wrapToggle);
  wrapLabel.appendChild(wrapText);
  headerDiv.appendChild(wrapLabel);

  const select = document.createElement('select');
  select.style.cssText =
    'border:1px solid var(--border);background:var(--bg);color:var(--fg);border-radius:8px;padding:6px 8px;font-size:12px;';
  const options: Array<{ id: EncodingId; label: string }> = [
    { id: 'ascii', label: 'ASCII' },
    { id: 'utf-8', label: 'UTF-8' },
    { id: 'windows-1251', label: 'Windows-1251' },
    { id: 'koi8-r', label: 'KOI8-R' },
    { id: 'iso-8859-1', label: 'ISO-8859-1' },
  ];
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = o.id;
    opt.textContent = o.label;
    select.appendChild(opt);
  }
  select.value = encoding;
  headerDiv.appendChild(select);

  // Viewer frame
  const frame = document.createElement('div');
  frame.style.cssText = 'flex:1;min-height:0;position:relative;overflow:hidden;background:var(--bg);';
  frame.tabIndex = 0;
  frameDiv = frame;
  rootEl = frame;
  root.appendChild(frame);

  contentDiv = document.createElement('div');
  contentDiv.style.cssText = `position:absolute;left:8px;top:8px;right:${8 + SCROLLBAR_WIDTH + SCROLLBAR_PADDING}px;bottom:8px;overflow:hidden;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace;color:var(--fg);`;
  frame.appendChild(contentDiv);

  scrollbarTrack = document.createElement('div');
  scrollbarTrack.style.cssText = `position:absolute;top:${8}px;bottom:${8}px;right:${8}px;width:${SCROLLBAR_WIDTH}px;border-radius:999px;background:var(--bg-secondary);border:1px solid var(--border);`;
  frame.appendChild(scrollbarTrack);

  scrollbarThumb = document.createElement('div');
  scrollbarThumb.style.cssText =
    'position:absolute;left:1px;right:1px;top:1px;height:20px;border-radius:999px;background:var(--entry-selected);border:1px solid var(--border-active);';
  scrollbarTrack.appendChild(scrollbarThumb);

  const measureCell = () => {
    if (!contentDiv) return;
    const probe = document.createElement('span');
    probe.textContent = 'M';
    probe.style.visibility = 'hidden';
    probe.style.position = 'absolute';
    probe.style.left = '-10000px';
    probe.style.top = '-10000px';
    contentDiv.appendChild(probe);
    const r = probe.getBoundingClientRect();
    contentDiv.removeChild(probe);
    charW = Math.max(6, r.width || 8);
    charH = Math.max(10, r.height || 16);

    const w = contentDiv.clientWidth;
    const h = contentDiv.clientHeight;
    cols = Math.max(10, Math.floor(w / charW));
    rows = Math.max(1, Math.floor(h / charH));
  };

  const render = async () => {
    if (!contentDiv) return;
    contentDiv.innerHTML = '';
    const grid = await renderGrid(hostApi, props);
    for (const line of grid) {
      const div = document.createElement('div');
      div.style.whiteSpace = 'pre';
      div.style.lineHeight = `${charH}px`;
      div.textContent = line.text;
      contentDiv.appendChild(div);
    }
    updateScrollbarThumb();
  };

  const stopInertia = () => {
    if (inertiaFrame != null) {
      cancelAnimationFrame(inertiaFrame);
      inertiaFrame = null;
    }
    touchVelocity = 0;
  };

  const startInertia = () => {
    stopInertia();
    if (Math.abs(touchVelocity) < 0.01) return;
    const decay = 0.95;
    const step = async () => {
      if (Math.abs(touchVelocity) < 0.01) {
        stopInertia();
        return;
      }
      const deltaPixels = touchVelocity * 16; // assume ~60fps → ~16ms
      const lines = deltaPixels / charH;
      if (lines > 0) await scrollDown(Math.max(1, Math.round(lines)));
      else if (lines < 0) await scrollUp(Math.max(1, Math.round(-lines)));
      touchVelocity *= decay;
      inertiaFrame = requestAnimationFrame(() => {
        void step();
      });
    };
    inertiaFrame = requestAnimationFrame(() => {
      void step();
    });
  };

  const scrollDown = async (n: number) => {
    if (!wrapMode) {
      let pos = dpyStart;
      for (let i = 0; i < n; i++) {
        const built = await buildGridLine(hostApi, props.filePath, pos, cols, false);
        if (built.byteEnd === pos) break;
        pos = built.byteEnd;
        if (pos >= fileSize) break;
      }
      dpyStart = clampDpyStart(pos);
      await render();
      return;
    }

    // Wrap mode: move within paragraph by visual rows; crossing newline advances to next paragraph.
    let pos = dpyStart;
    let skip = dpyParagraphSkipLines;
    for (let i = 0; i < n; i++) {
      const built = await buildGridLine(hostApi, props.filePath, pos, cols, true);
      if (built.byteEnd === pos) break;
      if (built.byteStart === pos && built.byteEnd > pos) {
        // If we wrapped (didn't hit newline), just advance skip; otherwise we moved to next paragraph.
        // We can detect newline consumption by checking if the last consumed byte was \n or \r.
        const lastByte = await getByte(hostApi, props.filePath, built.byteEnd - 1);
        const newlineConsumed = lastByte === 0x0a || lastByte === 0x0d;
        if (newlineConsumed) {
          pos = built.byteEnd;
          dpyStart = clampDpyStart(pos);
          skip = 0;
          dpyParagraphSkipLines = 0;
        } else {
          // Wrapped row within same paragraph.
          skip += 1;
          dpyParagraphSkipLines = skip;
        }
      }
      // advance position for subsequent steps from the *actual* next row start
      pos = built.byteEnd;
      if (pos >= fileSize) break;
    }
    await render();
  };

  const scrollUp = async (n: number) => {
    if (!wrapMode) {
      let pos = dpyStart;
      for (let i = 0; i < n; i++) {
        pos = await findPrevLineStart(hostApi, props.filePath, pos);
        if (pos === 0) break;
      }
      dpyStart = clampDpyStart(pos);
      await render();
      return;
    }

    // Wrap mode:
    // - If we have skipped wrapped rows inside current paragraph, decrease that.
    // - Otherwise, go to previous paragraph and position at its last wrapped row.
    for (let i = 0; i < n; i++) {
      if (dpyParagraphSkipLines > 0) {
        dpyParagraphSkipLines -= 1;
        continue;
      }
      const prevParagraphStart = await findPrevLineStart(hostApi, props.filePath, dpyStart);
      dpyStart = clampDpyStart(prevParagraphStart);
      // compute last wrapped row in that paragraph (best-effort; cap to avoid pathological files)
      let pos = dpyStart;
      let count = 0;
      let lastRowStart = dpyStart;
      for (let guard = 0; guard < 5000; guard++) {
        const built = await buildGridLine(hostApi, props.filePath, pos, cols, true);
        if (built.byteEnd === pos) break;
        const lastByte = await getByte(hostApi, props.filePath, built.byteEnd - 1);
        const newlineConsumed = lastByte === 0x0a || lastByte === 0x0d;
        if (newlineConsumed) break;
        lastRowStart = pos;
        pos = built.byteEnd;
        count++;
      }
      dpyParagraphSkipLines = Math.max(0, count);
      // Now we're effectively at the last row; scrollUp one more step will reduce skip.
    }
    await render();
  };

  const jumpToRatio = async (ratio: number) => {
    const next = clampDpyStart(Math.floor(ratio * Math.max(0, fileSize - 1)));
    dpyStart = await findPrevLineStart(hostApi, props.filePath, next);
    await render();
  };

  // cleanup previous handlers
  if (keydownHandler) document.removeEventListener('keydown', keydownHandler);
  if (resizeHandler) window.removeEventListener('resize', resizeHandler);
  if (wheelHandler && frameDiv) frameDiv.removeEventListener('wheel', wheelHandler);
  if (pointerMoveHandler) window.removeEventListener('pointermove', pointerMoveHandler);
  if (pointerUpHandler) window.removeEventListener('pointerup', pointerUpHandler);

  measureCell();
  await render();

  select.addEventListener('change', async () => {
    setEncoding(select.value as EncodingId);
    await render();
  });

  wrapToggle.addEventListener('change', async () => {
    wrapMode = wrapToggle.checked;
    dpyParagraphSkipLines = 0;
    // Align dpyStart to a real line start when entering wrap mode (paragraph start).
    if (wrapMode) dpyStart = await findPrevLineStart(hostApi, props.filePath, dpyStart);
    await render();
  });

  wheelHandler = (e: WheelEvent) => {
    e.preventDefault();
    const lines = Math.round(e.deltaY / charH);
    if (lines > 0) void scrollDown(Math.max(1, lines));
    else if (lines < 0) void scrollUp(Math.max(1, -lines));
  };
  frame.addEventListener('wheel', wheelHandler, { passive: false });

  frame.addEventListener('pointerdown', (e: PointerEvent) => {
    if (e.pointerType !== 'touch') return;
    stopInertia();
    lastTouchY = e.clientY;
    lastTouchTime = performance.now();
  });

  frame.addEventListener('pointermove', (e: PointerEvent) => {
    if (e.pointerType !== 'touch' || lastTouchTime === 0) return;
    const now = performance.now();
    const dy = e.clientY - lastTouchY;
    const dt = now - lastTouchTime || 1;
    const lines = dy / charH;
    if (lines > 0) void scrollUp(Math.max(1, Math.round(lines)));
    else if (lines < 0) void scrollDown(Math.max(1, Math.round(-lines)));
    touchVelocity = dy / dt;
    lastTouchY = e.clientY;
    lastTouchTime = now;
  });

  frame.addEventListener('pointerup', (e: PointerEvent) => {
    if (e.pointerType !== 'touch') return;
    lastTouchTime = 0;
    startInertia();
  });

  const onThumbPointerDown = (e: PointerEvent) => {
    if (!scrollbarThumb) return;
    dragging = true;
    const rect = scrollbarThumb.getBoundingClientRect();
    dragOffsetY = e.clientY - rect.top;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    e.preventDefault();
  };
  scrollbarThumb.addEventListener('pointerdown', onThumbPointerDown);

  const onTrackPointerDown = (e: PointerEvent) => {
    if (!scrollbarTrack || !scrollbarThumb) return;
    const trackRect = scrollbarTrack.getBoundingClientRect();
    const y = e.clientY - trackRect.top;
    const thumbH = scrollbarThumb.clientHeight;
    const ratio = (y - thumbH / 2) / Math.max(1, trackRect.height - thumbH);
    void jumpToRatio(Math.max(0, Math.min(1, ratio)));
    e.preventDefault();
  };
  scrollbarTrack.addEventListener('pointerdown', onTrackPointerDown);

  pointerMoveHandler = (e: PointerEvent) => {
    if (!dragging || !scrollbarTrack || !scrollbarThumb) return;
    const trackRect = scrollbarTrack.getBoundingClientRect();
    const thumbH = scrollbarThumb.clientHeight;
    const y = e.clientY - trackRect.top - dragOffsetY;
    const ratio = y / Math.max(1, trackRect.height - thumbH);
    void jumpToRatio(Math.max(0, Math.min(1, ratio)));
  };
  window.addEventListener('pointermove', pointerMoveHandler);

  pointerUpHandler = () => {
    dragging = false;
  };
  window.addEventListener('pointerup', pointerUpHandler);

  keydownHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') hostApi.onClose();
    if (e.key === 'ArrowDown') { e.preventDefault(); void scrollDown(1); }
    if (e.key === 'ArrowUp') { e.preventDefault(); void scrollUp(1); }
    if (e.key === 'PageDown') { e.preventDefault(); void scrollDown(rows); }
    if (e.key === 'PageUp') { e.preventDefault(); void scrollUp(rows); }
    if (e.key === 'Home') { e.preventDefault(); dpyStart = 0; void render(); }
    if (e.key === 'End') { e.preventDefault(); void jumpToRatio(1); }
  };
  document.addEventListener('keydown', keydownHandler);

  resizeHandler = () => {
    measureCell();
    void render();
  };
  window.addEventListener('resize', resizeHandler);
}

export function unmountViewer(): void {
  if (keydownHandler) {
    document.removeEventListener('keydown', keydownHandler);
    keydownHandler = null;
  }
  if (resizeHandler) {
    window.removeEventListener('resize', resizeHandler);
    resizeHandler = null;
  }
  if (wheelHandler && frameDiv) frameDiv.removeEventListener('wheel', wheelHandler);
  wheelHandler = null;
  if (pointerMoveHandler) {
    window.removeEventListener('pointermove', pointerMoveHandler);
    pointerMoveHandler = null;
  }
  if (pointerUpHandler) {
    window.removeEventListener('pointerup', pointerUpHandler);
    pointerUpHandler = null;
  }
  frameDiv = null;
  contentDiv = null;
  headerDiv = null;
  scrollbarTrack = null;
  scrollbarThumb = null;
  if (rootEl?.parentNode) {
    rootEl.parentNode.removeChild(rootEl);
  }
  rootEl = null;
}
