export interface ViewerProps {
  filePath: string;
  fileName: string;
  fileSize: number;
  inline?: boolean;
}

export interface HostApi {
  readFile(path: string): Promise<ArrayBuffer>;
  readFileText(path: string): Promise<string>;
  readFileRange?(path: string, offset: number, length: number): Promise<ArrayBuffer>;
  onFileChange?(callback: () => void): () => void;
  statFile?(path: string): Promise<{ size: number; mtimeMs: number }>;
  getTheme(): Promise<string>;
  onClose(): void;
  executeCommand?<T = unknown>(command: string, args?: unknown): Promise<T>;
}

export interface ViewerExtensionApi {
  mount(root: HTMLElement, hostApi: HostApi, props: ViewerProps): Promise<void>;
  unmount(): Promise<void>;
}
