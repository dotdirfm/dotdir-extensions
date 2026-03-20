const CHEVRON_LEFT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="22" height="22"><polyline points="15 18 9 12 15 6"/></svg>';
const CHEVRON_RIGHT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="22" height="22"><polyline points="9 6 15 12 9 18"/></svg>';

export interface NavOverlayHandle {
  destroy(): void;
  updateIndex(index: number, total: number): void;
}

export const MEDIA_PATTERNS = ['*.png', '*.jpg', '*.jpeg', '*.gif', '*.bmp', '*.webp', '*.ico', '*.svg', '*.avif', '*.tiff', '*.tif', '*.mp4', '*.m4v', '*.webm', '*.ogv', '*.ogg', '*.mov'];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, css: string, html?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.style.cssText = css;
  if (html) e.innerHTML = html;
  return e;
}

export function createNavOverlay(container: HTMLElement): NavOverlayHandle | null {
  const exec = frdy.executeCommand.bind(frdy);

  // Top-right counter badge: "3 / 42"
  const counter = el('div',
    'position:absolute;top:8px;right:8px;z-index:20;' +
    'background:rgba(0,0,0,.55);color:rgba(255,255,255,.85);' +
    'font:12px/1 system-ui,-apple-system,sans-serif;' +
    'padding:4px 10px;border-radius:12px;user-select:none;pointer-events:none;' +
    'backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);' +
    'display:none;');

  // Arrow buttons (left & right edges)
  const btnCss =
    'position:absolute;top:50%;transform:translateY(-50%);z-index:20;' +
    'width:36px;height:36px;border-radius:50%;border:none;cursor:pointer;' +
    'background:rgba(0,0,0,.45);color:rgba(255,255,255,.8);' +
    'display:flex;align-items:center;justify-content:center;' +
    'opacity:0;transition:opacity .2s;pointer-events:auto;' +
    'backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);';

  const btnPrev = el('button', btnCss + 'left:8px;', CHEVRON_LEFT);
  const btnNext = el('button', btnCss + 'right:8px;', CHEVRON_RIGHT);
  btnPrev.tabIndex = -1;
  btnNext.tabIndex = -1;

  container.appendChild(counter);
  container.appendChild(btnPrev);
  container.appendChild(btnNext);

  let currentIndex = -1;
  let totalCount = 0;

  function updateVisibility() {
    counter.style.display = totalCount > 0 ? '' : 'none';
    btnPrev.style.visibility = currentIndex > 0 ? 'visible' : 'hidden';
    btnNext.style.visibility = (currentIndex >= 0 && currentIndex < totalCount - 1) ? 'visible' : 'hidden';
  }

  function updateIndex(index: number, total: number) {
    currentIndex = index;
    totalCount = total;
    counter.textContent = total > 0 ? `${index + 1}\u2009/\u2009${total}` : '';
    updateVisibility();
  }

  // Show/hide arrows on hover
  const showArrows = () => { btnPrev.style.opacity = '1'; btnNext.style.opacity = '1'; };
  const hideArrows = () => { btnPrev.style.opacity = '0'; btnNext.style.opacity = '0'; };
  container.addEventListener('mouseenter', showArrows);
  container.addEventListener('mouseleave', hideArrows);

  // Click handlers
  const navPrev = (e: Event) => {
    e.stopPropagation();
    exec('navigatePrev', { patterns: MEDIA_PATTERNS });
  };
  const navNext = (e: Event) => {
    e.stopPropagation();
    exec('navigateNext', { patterns: MEDIA_PATTERNS });
  };
  btnPrev.addEventListener('click', navPrev);
  btnNext.addEventListener('click', navNext);

  // Fetch initial index
  exec<{ index: number; total: number }>('getFileIndex', { patterns: MEDIA_PATTERNS })
    .then((r) => { if (r) updateIndex(r.index, r.total); })
    .catch(() => {});

  return {
    destroy() {
      container.removeEventListener('mouseenter', showArrows);
      container.removeEventListener('mouseleave', hideArrows);
      btnPrev.removeEventListener('click', navPrev);
      btnNext.removeEventListener('click', navNext);
      counter.remove();
      btnPrev.remove();
      btnNext.remove();
    },
    updateIndex,
  };
}
