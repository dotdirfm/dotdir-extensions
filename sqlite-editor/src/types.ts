/**
 * Minimal types for host ↔ extension communication.
 * Mirrors the shape used by `monaco-editor`.
 */

export interface EditorProps {
  filePath: string;
  fileName: string;
  langId: string;
  extensionDirPath?: string;
}

export interface HostApi {
  readFile(path: string): Promise<ArrayBuffer>;
  readFileText(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  getTheme(): Promise<string>;
  onClose(): void;
  executeCommand?<T = unknown>(command: string, args?: unknown): Promise<T>;
}

declare global {
  var dotdir: HostApi;
}

export interface EditorExtensionApi {
  mount(root: HTMLElement, props: EditorProps): Promise<void>;
  unmount(): Promise<void>;
  setDirty?(dirty: boolean): void;
}

