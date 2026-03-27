export interface ViewerProps {
  filePath: string;
  fileName: string;
  fileSize: number;
  inline?: boolean;
}

export interface HostApi {
  readFile(path: string): Promise<ArrayBuffer>;
  readFileText(path: string): Promise<string>;
  readFileRange(path: string, offset: number, length: number): Promise<ArrayBuffer>;
  onFileChange(callback: () => void): () => void;
  getTheme(): Promise<string>;
  onClose(): void;
  executeCommand<T = unknown>(command: string, args?: unknown): Promise<T>;

  /**
   * Commands + keybindings API exposed via `window.dotdir.commands.*`.
   * This mimics VS Code's command/keybinding model.
   */
  commands: {
    registerCommand: (
      commandId: string,
      handler: (...args: unknown[]) => void | Promise<void>,
      options?: { title?: string; category?: string; icon?: string; when?: string }
    ) => { dispose: () => void };
    registerKeybinding: (
      binding: { command: string; key: string; mac?: string; when?: string }
    ) => { dispose: () => void };
  };
}

declare global {
  var dotdir: HostApi;
}

export interface ViewerExtensionApi {
  mount(root: HTMLElement, props: ViewerProps): Promise<void>;
  unmount(): Promise<void>;
}
