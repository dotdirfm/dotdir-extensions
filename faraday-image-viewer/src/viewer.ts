import type { ViewerProps, HostApi } from './types';

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  bmp: 'image/bmp', webp: 'image/webp', ico: 'image/x-icon', svg: 'image/svg+xml',
  avif: 'image/avif', tiff: 'image/tiff', tif: 'image/tiff',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg',
  ogg: 'video/ogg', mov: 'video/quicktime',
};

function getExt(name: string): string {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
}

let objectUrl: string | null = null;
let rootEl: HTMLElement | null = null;
let keydownHandler: ((e: KeyboardEvent) => void) | null = null;
let focusinHandler: ((e: FocusEvent) => void) | null = null;

export async function mountViewer(hostApi: HostApi, props: ViewerProps): Promise<void> {
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = null;
  if (keydownHandler) {
    document.removeEventListener('keydown', keydownHandler);
    keydownHandler = null;
  }
  if (focusinHandler) {
    document.removeEventListener('focusin', focusinHandler);
    focusinHandler = null;
  }

  const ext = getExt(props.fileName);
  const mime = MIME[ext] || 'application/octet-stream';
  const isVideo = /^(mp4|webm|ogv|ogg|mov|m4v)$/.test(ext);
  const inline = !!props.inline;

  document.documentElement.style.width = '100%';
  document.documentElement.style.height = '100%';
  document.documentElement.style.margin = '0';
  document.documentElement.style.padding = '0';
  document.body.innerHTML = '';
  document.body.style.margin = '0';
  document.body.style.padding = '0';
  document.body.style.width = '100%';
  document.body.style.height = '100%';
  document.body.style.display = 'flex';
  document.body.style.flexDirection = 'column';
  document.body.style.overflow = 'hidden';
  if (inline) {
    document.body.tabIndex = -1;
  }

  const header = document.createElement('div');
  header.style.cssText = 'display:flex;align-items:center;padding:6px 10px;border-bottom:1px solid #333;flex-shrink:0;';
  const title = document.createElement('span');
  title.textContent = props.fileName;
  title.style.flex = '1';
  header.appendChild(title);
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '×';
  closeBtn.title = 'Close (Esc)';
  closeBtn.style.cssText = 'background:transparent;border:none;cursor:pointer;font-size:18px;padding:0 8px;';
  closeBtn.onclick = () => hostApi.onClose();
  header.appendChild(closeBtn);
  document.body.appendChild(header);

  const wrap = document.createElement('div');
  wrap.style.cssText = 'flex:1;min-height:0;min-width:0;width:100%;display:flex;align-items:center;justify-content:center;overflow:auto;background:#1a1a1a;';
  if (inline) wrap.tabIndex = -1;
  rootEl = wrap;
  document.body.appendChild(wrap);

  const buf = await hostApi.readFile(props.filePath);
  const blob = new Blob([buf], { type: mime });
  const url = URL.createObjectURL(blob);
  objectUrl = url;

  if (isVideo) {
    const video = document.createElement('video');
    video.src = url;
    video.controls = true;
    video.style.maxWidth = '100%';
    video.style.maxHeight = '100%';
    if (inline) video.tabIndex = -1;
    video.onclick = () => (video.paused ? video.play() : video.pause());
    wrap.appendChild(video);
  } else {
    const img = document.createElement('img');
    img.src = url;
    img.alt = props.fileName;
    img.style.maxWidth = '100%';
    img.style.maxHeight = '100%';
    img.style.width = 'auto';
    img.style.height = 'auto';
    img.style.objectFit = 'contain';
    if (inline) img.tabIndex = -1;
    wrap.appendChild(img);
  }

  const mediaFiles = props.mediaFiles ?? [];
  const idx = mediaFiles.findIndex((f) => f.path === props.filePath);
  const onNav = hostApi.onNavigateMedia;

  keydownHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') hostApi.onClose();
    if (!onNav || mediaFiles.length === 0) return;
    if (e.key === 'ArrowLeft' && idx > 0) onNav(mediaFiles[idx - 1]);
    if (e.key === 'ArrowRight' && idx >= 0 && idx < mediaFiles.length - 1) onNav(mediaFiles[idx + 1]);
  };
  document.addEventListener('keydown', keydownHandler);

  if (inline) {
    focusinHandler = () => {
      const el = document.activeElement;
      if (el && el !== document.body) (el as HTMLElement).blur();
    };
    document.addEventListener('focusin', focusinHandler);
  }
}

export function unmountViewer(): void {
  if (keydownHandler) {
    document.removeEventListener('keydown', keydownHandler);
    keydownHandler = null;
  }
  if (focusinHandler) {
    document.removeEventListener('focusin', focusinHandler);
    focusinHandler = null;
  }
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  }
  if (rootEl?.parentNode) rootEl.parentNode.removeChild(rootEl);
  rootEl = null;
}
