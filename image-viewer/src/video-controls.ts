const PLAY = '<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><polygon points="6,3 20,12 6,21"/></svg>';
const PAUSE = '<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><rect x="5" y="3" width="4" height="18"/><rect x="15" y="3" width="4" height="18"/></svg>';

function fmt(s: number): string {
  if (!isFinite(s) || s < 0) return '0:00';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const ms = String(m).padStart(h ? 2 : 1, '0');
  const ss = String(sec).padStart(2, '0');
  return h ? `${h}:${ms}:${ss}` : `${ms}:${ss}`;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, css: string, html?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.style.cssText = css;
  if (html) e.innerHTML = html;
  return e;
}

export interface ControlsHandle {
  destroy(): void;
  setStreaming(active: boolean): void;
}

export function attachControls(video: HTMLVideoElement, container: HTMLElement): ControlsHandle {
  // --- DOM ---
  const bar = el('div',
    'position:absolute;bottom:0;left:0;right:0;' +
    'background:linear-gradient(transparent,rgba(0,0,0,.75));' +
    'padding:20px 12px 10px;display:flex;align-items:center;gap:10px;' +
    'opacity:0;pointer-events:none;transition:opacity .25s;z-index:10;cursor:default;');

  const btn = el('button',
    'background:none;border:none;color:#fff;cursor:pointer;' +
    'width:28px;height:28px;padding:0;display:flex;align-items:center;justify-content:center;flex-shrink:0;',
    PLAY);

  const trackWrap = el('div', 'flex:1;height:18px;display:flex;align-items:center;cursor:pointer;');
  const track = el('div', 'width:100%;height:4px;background:rgba(255,255,255,.25);border-radius:2px;position:relative;transition:height .15s;');
  const bufBar = el('div', 'position:absolute;top:0;left:0;height:100%;background:rgba(255,255,255,.3);border-radius:2px;width:0;pointer-events:none;');
  const fillBar = el('div', 'position:absolute;top:0;left:0;height:100%;background:#fff;border-radius:2px;width:0;pointer-events:none;');
  track.append(bufBar, fillBar);
  trackWrap.appendChild(track);

  const time = el('span',
    'color:#fff;font:13px/1 monospace;white-space:nowrap;user-select:none;flex-shrink:0;',
    '0:00\u2009/\u20090:00');

  const badge = el('span',
    'font:10px/1 sans-serif;padding:2px 5px;border-radius:3px;white-space:nowrap;user-select:none;flex-shrink:0;' +
    'background:rgba(255,255,255,.15);color:rgba(255,255,255,.6);display:none;');

  bar.append(btn, trackWrap, time, badge);
  container.appendChild(bar);

  // --- State ---
  let hideTimer = 0;
  let scrubbing = false;

  // --- Helpers ---
  function show() {
    bar.style.opacity = '1';
    bar.style.pointerEvents = 'auto';
    window.clearTimeout(hideTimer);
    if (!video.paused) hideTimer = window.setTimeout(hide, 3000);
  }
  function hide() {
    if (scrubbing) return;
    bar.style.opacity = '0';
    bar.style.pointerEvents = 'none';
  }

  function updateBtn() { btn.innerHTML = video.paused ? PLAY : PAUSE; }

  function updateProgress() {
    const d = video.duration;
    if (!isFinite(d) || d === 0) return;
    fillBar.style.width = `${(video.currentTime / d) * 100}%`;
    time.textContent = `${fmt(video.currentTime)}\u2009/\u2009${fmt(d)}`;
    if (video.buffered.length > 0) {
      bufBar.style.width = `${(video.buffered.end(video.buffered.length - 1) / d) * 100}%`;
    }
  }

  function seekTo(e: MouseEvent) {
    const r = track.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    video.currentTime = ratio * video.duration;
    updateProgress();
  }

  // --- Events ---
  const handlers: [EventTarget, string, EventListener, AddEventListenerOptions?][] = [];
  function on<T extends EventTarget>(t: T, ev: string, fn: EventListener, opts?: AddEventListenerOptions) {
    t.addEventListener(ev, fn, opts);
    handlers.push([t, ev, fn, opts]);
  }

  on(container, 'mousemove', show);
  on(container, 'mouseenter', show);
  on(container, 'mouseleave', () => { if (!video.paused) hide(); });
  on(btn, 'click', (e) => { e.stopPropagation(); video.paused ? video.play() : video.pause(); });
  on(video, 'click', () => { video.paused ? video.play() : video.pause(); show(); });
  on(video, 'play', () => { updateBtn(); show(); });
  on(video, 'pause', () => { updateBtn(); show(); });
  on(video, 'timeupdate', updateProgress);
  on(video, 'durationchange', updateProgress);
  on(video, 'progress', updateProgress);

  // Scrubbing
  on(trackWrap, 'mousedown', ((e: MouseEvent) => {
    scrubbing = true;
    seekTo(e);
    const move = (e: MouseEvent) => seekTo(e);
    const up = () => { scrubbing = false; document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }) as EventListener);

  // Hover expand
  on(trackWrap, 'mouseenter', () => { track.style.height = '6px'; });
  on(trackWrap, 'mouseleave', () => { track.style.height = '4px'; });

  show();

  return {
    destroy() {
      window.clearTimeout(hideTimer);
      for (const [t, ev, fn, opts] of handlers) t.removeEventListener(ev, fn, opts);
      bar.remove();
    },
    setStreaming(active: boolean) {
      badge.style.display = '';
      badge.textContent = active ? 'STREAM' : 'BLOB';
      badge.style.background = active ? 'rgba(76,175,80,.35)' : 'rgba(255,255,255,.15)';
      badge.style.color = active ? 'rgba(76,175,80,.9)' : 'rgba(255,255,255,.6)';
    },
  };
}
