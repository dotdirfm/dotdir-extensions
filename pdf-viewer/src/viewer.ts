import type { ViewerProps } from './types';

let objectUrl: string | null = null;
let rootEl: HTMLElement | null = null;
let keydownHandler: ((e: KeyboardEvent) => void) | null = null;

export async function mountViewer(root: HTMLElement, props: ViewerProps): Promise<void> {
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = null;
  if (keydownHandler) {
    document.removeEventListener('keydown', keydownHandler);
    keydownHandler = null;
  }

  root.innerHTML = '';
  root.style.margin = '0';
  root.style.padding = '0';
  root.style.width = '100%';
  root.style.height = '100%';
  root.style.display = 'flex';
  root.style.flexDirection = 'column';
  root.style.overflow = 'hidden';
  if (props.inline) {
    root.tabIndex = -1;
  }

  const wrap = document.createElement('div');
  wrap.style.cssText = 'flex:1;min-height:0;min-width:0;width:100%;height:100%;overflow:auto;background:#525252;';
  if (props.inline) wrap.tabIndex = -1;
  rootEl = wrap;
  root.appendChild(wrap);

  const buf = await frdy.readFile(props.filePath);
  const blob = new Blob([buf], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  objectUrl = url;

  const embed = document.createElement('embed');
  embed.src = url + '#toolbar=1';
  embed.type = 'application/pdf';
  embed.style.cssText = 'width:100%;height:100%;min-height:600px;border:none;';
  if (props.inline) embed.tabIndex = -1;
  embed.setAttribute('aria-label', `PDF: ${props.fileName}`);
  wrap.appendChild(embed);

  keydownHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') frdy.onClose();
  };
  document.addEventListener('keydown', keydownHandler);
}

export function unmountViewer(): void {
  if (keydownHandler) {
    document.removeEventListener('keydown', keydownHandler);
    keydownHandler = null;
  }
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  }
  if (rootEl?.parentNode) {
    rootEl.parentNode.removeChild(rootEl);
  }
  rootEl = null;
}
