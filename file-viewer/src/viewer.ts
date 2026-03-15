import type { ViewerProps, HostApi } from './types';

const LINE_HEIGHT = 20;
const CHUNK_SIZE = 65536;
const BACKWARD_SEARCH_INITIAL = 256;
const BACKWARD_SEARCH_MAX = 8192;

interface ScreenLine {
  text: string;
  byteStart: number;
  byteEnd: number;
}

let rootEl: HTMLDivElement | null = null;
let keydownHandler: ((e: KeyboardEvent) => void) | null = null;
let resizeHandler: (() => void) | null = null;
let fileSize = 0;
let filePos = 0;
let screenLines: ScreenLine[] = [];
let viewportRows = 30;
let viewportCols = 120;
let avgBytesPerLine = 80;
const decoder = new TextDecoder();

function splitBytesToLines(bytes: Uint8Array, baseOffset: number): { text: string; byteStart: number; byteEnd: number }[] {
  const lines: { text: string; byteStart: number; byteEnd: number }[] = [];
  let lineStart = 0;
  for (let i = 0; i <= bytes.length; i++) {
    if (i === bytes.length || bytes[i] === 0x0a) {
      lines.push({
        text: decoder.decode(bytes.subarray(lineStart, i)),
        byteStart: baseOffset + lineStart,
        byteEnd: baseOffset + (i < bytes.length ? i + 1 : i),
      });
      lineStart = i + 1;
    }
  }
  return lines;
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

async function fillScreen(hostApi: HostApi, path: string, fromByte: number, rowCount: number): Promise<ScreenLine[]> {
  if (fileSize === 0) return [];
  const lines: ScreenLine[] = [];
  let offset = Math.max(0, Math.min(fromByte, fileSize));
  let readLen = Math.max(avgBytesPerLine * rowCount * 3, 4096);
  let attempts = 0;

  while (lines.length < rowCount && offset < fileSize && attempts < 3) {
    const bytes = await readRange(hostApi, path, offset, readLen);
    if (bytes.length === 0) break;
    const rawLines = splitBytesToLines(bytes, offset);
    for (const raw of rawLines) {
      lines.push({ text: raw.text, byteStart: raw.byteStart, byteEnd: raw.byteEnd });
      if (lines.length >= rowCount) break;
    }
    const last = rawLines[rawLines.length - 1];
    if (last) offset = last.byteEnd;
    else break;
    readLen *= 2;
    attempts++;
  }
  const result = lines.slice(0, rowCount);
  if (result.length > 0) {
    const lastSl = result[result.length - 1];
    avgBytesPerLine = avgBytesPerLine * 0.7 + (lastSl.byteEnd - fromByte) / result.length * 0.3;
  }
  return result;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export async function mountViewer(root: HTMLElement, hostApi: HostApi, props: ViewerProps): Promise<void> {
  fileSize = props.fileSize;
  filePos = 0;
  screenLines = [];
  avgBytesPerLine = 80;

  root.innerHTML = '';
  root.style.margin = '0';
  root.style.padding = '0';
  root.style.height = '100%';
  root.style.display = 'flex';
  root.style.flexDirection = 'column';
  root.style.overflow = 'hidden';
  root.style.fontFamily = 'monospace';
  root.style.fontSize = '13px';

  const textDiv = document.createElement('div');
  textDiv.style.cssText = 'flex:1;min-height:0;overflow:auto;padding:8px;white-space:pre;';
  textDiv.tabIndex = 0;
  rootEl = textDiv;
  root.appendChild(textDiv);

  const renderLines = (lines: ScreenLine[]) => {
    textDiv.innerHTML = '';
    lines.forEach((line) => {
      const div = document.createElement('div');
      div.style.lineHeight = `${LINE_HEIGHT}px`;
      div.textContent = line.text || '\u00a0';
      textDiv.appendChild(div);
    });
  };

  const updateView = async () => {
    const lines = await fillScreen(hostApi, props.filePath, filePos, viewportRows);
    screenLines = lines;
    renderLines(lines);
  };

  const measure = () => {
    const h = textDiv.clientHeight;
    const w = textDiv.clientWidth - 24;
    viewportRows = Math.max(1, Math.floor(h / LINE_HEIGHT));
    viewportCols = Math.max(10, Math.floor(w / 7.8));
  };

  if (keydownHandler) {
    document.removeEventListener('keydown', keydownHandler);
    keydownHandler = null;
  }
  if (resizeHandler) {
    window.removeEventListener('resize', resizeHandler);
    resizeHandler = null;
  }

  measure();
  await updateView();

  const scrollDown = async (n: number) => {
    if (screenLines.length === 0) return;
    if (screenLines[screenLines.length - 1].byteEnd >= fileSize) return;
    if (n >= viewportRows) {
      filePos = screenLines[screenLines.length - 1].byteStart;
    } else {
      const remaining = screenLines.slice(n);
      const appendFrom = screenLines[screenLines.length - 1].byteEnd;
      const newLines = await fillScreen(hostApi, props.filePath, appendFrom, n);
      const all = [...remaining, ...newLines].slice(0, viewportRows);
      filePos = all.length > 0 ? all[0].byteStart : filePos;
      screenLines = all;
      renderLines(screenLines);
      return;
    }
    await updateView();
  };

  const scrollUp = async (n: number) => {
    if (screenLines.length === 0 || filePos === 0) return;
    for (let i = 0; i < Math.min(n, viewportRows); i++) {
      filePos = await findPrevLineStart(hostApi, props.filePath, filePos);
      if (filePos === 0) break;
    }
    await updateView();
  };

  textDiv.addEventListener('wheel', (e) => {
    e.preventDefault();
    const lines = Math.round(e.deltaY / LINE_HEIGHT);
    if (lines > 0) scrollDown(Math.max(1, lines));
    else if (lines < 0) scrollUp(Math.max(1, -lines));
  });

  keydownHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') hostApi.onClose();
    if (e.key === 'ArrowDown') { e.preventDefault(); scrollDown(1); }
    if (e.key === 'ArrowUp') { e.preventDefault(); scrollUp(1); }
    if (e.key === 'PageDown') { e.preventDefault(); scrollDown(viewportRows); }
    if (e.key === 'PageUp') { e.preventDefault(); scrollUp(viewportRows); }
    if (e.key === 'Home') { filePos = 0; updateView(); }
    if (e.key === 'End') {
      void (async () => {
        let pos = fileSize;
        for (let i = 0; i < viewportRows && pos > 0; i++) pos = await findPrevLineStart(hostApi, props.filePath, pos);
        filePos = pos;
        await updateView();
      })();
    }
  };
  document.addEventListener('keydown', keydownHandler);

  resizeHandler = () => {
    measure();
    updateView();
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
  if (rootEl?.parentNode) {
    rootEl.parentNode.removeChild(rootEl);
  }
  rootEl = null;
}
