import {
  createNavOverlay,
  MEDIA_PATTERNS,
  type NavOverlayHandle,
} from "./nav-overlay";
import type { ViewerProps } from "./types";
import { attachControls, type ControlsHandle } from "./video-controls";
import { isStreamable, streamVideo } from "./video-stream";

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  bmp: "image/bmp",
  webp: "image/webp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
  avif: "image/avif",
  tiff: "image/tiff",
  tif: "image/tiff",
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  ogv: "video/ogg",
  ogg: "video/ogg",
  mov: "video/quicktime",
};

function getExt(name: string): string {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i + 1).toLowerCase();
}

let objectUrl: string | null = null;
let streamDestroy: (() => void) | null = null;
let controlsHandle: ControlsHandle | null = null;
let navHandle: NavOverlayHandle | null = null;
let rootEl: HTMLElement | null = null;
let keydownHandler: ((e: KeyboardEvent) => void) | null = null;
let focusinHandler: ((e: FocusEvent) => void) | null = null;
let disposeFileChange: (() => void) | null = null;
let disposeNavPrevCommand: { dispose: () => void } | null = null;
let disposeNavNextCommand: { dispose: () => void } | null = null;

function cleanup() {
  if (keydownHandler) {
    document.removeEventListener("keydown", keydownHandler);
    keydownHandler = null;
  }
  if (focusinHandler) {
    document.removeEventListener("focusin", focusinHandler);
    focusinHandler = null;
  }
  if (navHandle) {
    navHandle.destroy();
    navHandle = null;
  }
  if (controlsHandle) {
    controlsHandle.destroy();
    controlsHandle = null;
  }
  if (streamDestroy) {
    streamDestroy();
    streamDestroy = null;
  }
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  }
  if (disposeFileChange) {
    disposeFileChange();
    disposeFileChange = null;
  }
  if (disposeNavPrevCommand) {
    disposeNavPrevCommand.dispose();
    disposeNavPrevCommand = null;
  }
  if (disposeNavNextCommand) {
    disposeNavNextCommand.dispose();
    disposeNavNextCommand = null;
  }
}

export async function mountViewer(
  root: HTMLElement,
  props: ViewerProps,
): Promise<void> {
  cleanup();

  const ext = getExt(props.fileName);
  const mime = MIME[ext] || "application/octet-stream";
  const isVideo = /^(mp4|webm|ogv|ogg|mov|m4v)$/.test(ext);
  const canStream = isVideo && isStreamable(ext);
  const inline = !!props.inline;

  root.innerHTML = "";
  root.style.cssText =
    "margin:0;padding:0;width:100%;height:100%;display:flex;flex-direction:column;overflow:hidden;";
  if (inline) root.tabIndex = -1;

  const wrap = document.createElement("div");
  if (inline) wrap.tabIndex = -1;
  rootEl = wrap;
  root.appendChild(wrap);

  if (isVideo) {
    wrap.style.cssText =
      "flex:1;min-height:0;width:100%;position:relative;background:#000;overflow:hidden;";

    const video = document.createElement("video");
    video.style.cssText =
      "width:100%;height:100%;object-fit:contain;display:block;";
    video.autoplay = true;
    video.playsInline = true;
    if (inline) video.tabIndex = -1;
    wrap.appendChild(video);

    controlsHandle = attachControls(video, wrap);

    let fellBack = false;
    const fallbackToBlob = async () => {
      if (fellBack) return;
      fellBack = true;
      if (streamDestroy) {
        streamDestroy();
        streamDestroy = null;
      }
      const buf = await frdy.readFile(props.filePath);
      const blob = new Blob([buf], { type: mime });
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = URL.createObjectURL(blob);
      video.src = objectUrl;
      video.play().catch(() => {});
      controlsHandle?.setStreaming(false);
    };

    if (canStream) {
      controlsHandle.setStreaming(true);
      const timer = setTimeout(fallbackToBlob, 15000);
      video.addEventListener("canplay", () => clearTimeout(timer), {
        once: true,
      });
      video.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          fallbackToBlob();
        },
        { once: true },
      );
      try {
        streamDestroy = streamVideo(
          video,
          (offset, length) =>
            frdy.readFileRange(props.filePath, offset, length),
          props.fileSize,
        );
      } catch {
        clearTimeout(timer);
        await fallbackToBlob();
      }
    } else {
      controlsHandle.setStreaming(false);
    }
  } else {
    wrap.style.cssText =
      "flex:1;min-height:0;min-width:0;width:100%;display:flex;align-items:center;justify-content:center;overflow:auto;background:#1a1a1a;position:relative;";

    const buf = await frdy.readFile(props.filePath);
    const blob = new Blob([buf], { type: mime });
    objectUrl = URL.createObjectURL(blob);

    const img = document.createElement("img");
    img.src = objectUrl;
    img.alt = props.fileName;
    img.style.cssText =
      "max-width:100%;max-height:100%;width:auto;height:auto;object-fit:contain;";
    if (inline) img.tabIndex = -1;
    wrap.appendChild(img);
  }

  // Navigation overlay (arrows + counter)
  navHandle = createNavOverlay(wrap);

  // Arrow key navigation via Faraday command system (no document-level key listeners).
  const prevCommandId = "imageViewer.navigatePrev";
  const nextCommandId = "imageViewer.navigateNext";

  disposeNavPrevCommand = frdy.commands.registerCommand(
    prevCommandId,
    async () => {
      await frdy.executeCommand("navigatePrev", {
        patterns: MEDIA_PATTERNS,
      });
    },
    { title: "Image Viewer: Previous", when: "focusViewer" },
  );
  disposeNavNextCommand = frdy.commands.registerCommand(
    nextCommandId,
    async () => {
      await frdy.executeCommand("navigateNext", {
        patterns: MEDIA_PATTERNS,
      });
    },
    { title: "Image Viewer: Next", when: "focusViewer" },
  );

  // Re-subscribe to external file changes for this image/video.
  disposeFileChange = frdy.onFileChange(async () => {
    try {
      await mountViewer(root, props);
    } catch {
      // ignore refresh errors
    }
  });

  keydownHandler = (e: KeyboardEvent) => {
    if (e.key === "Escape") frdy.onClose();
    if (e.key === " " && isVideo) {
      e.preventDefault();
      const v = wrap.querySelector("video");
      if (v) v.paused ? v.play() : v.pause();
    }
  };
  document.addEventListener("keydown", keydownHandler);

  if (inline) {
    focusinHandler = () => {
      const el = document.activeElement;
      if (el && el !== document.body) (el as HTMLElement).blur();
    };
    document.addEventListener("focusin", focusinHandler);
  }
}

export function unmountViewer(): void {
  cleanup();
  if (rootEl?.parentNode) rootEl.parentNode.removeChild(rootEl);
  rootEl = null;
}
