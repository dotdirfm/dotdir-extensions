export interface MediaFileRef {
  path: string;
  name: string;
  size: number;
}

export interface ViewerProps {
  filePath: string;
  fileName: string;
  fileSize: number;
  inline?: boolean;
  mediaFiles?: MediaFileRef[];
}

export interface HostApi {
  readFile(path: string): Promise<ArrayBuffer>;
  readFileText(path: string): Promise<string>;
  getTheme(): Promise<string>;
  onClose(): void;
  onNavigateMedia?(file: MediaFileRef): void;
}

export interface ViewerExtensionApi {
  mount(root: HTMLElement, hostApi: HostApi, props: ViewerProps): Promise<void>;
  unmount(): Promise<void>;
}
