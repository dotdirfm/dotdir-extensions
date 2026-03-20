export interface ViewerProps {
  filePath: string;
  fileName: string;
  fileSize: number;
  inline?: boolean;
}

export interface HostApi {
  readFile(path: string): Promise<ArrayBuffer>;
  readFileText(path: string): Promise<string>;
  getTheme(): Promise<string>;
  onClose(): void;
  executeCommand?<T = unknown>(command: string, args?: unknown): Promise<T>;
}

declare global {
  var frdy: HostApi;
}

export interface ViewerExtensionApi {
  mount(root: HTMLElement, props: ViewerProps): Promise<void>;
  unmount(): Promise<void>;
}
