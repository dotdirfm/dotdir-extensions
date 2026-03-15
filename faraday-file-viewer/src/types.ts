export interface ViewerProps {
  filePath: string;
  fileName: string;
  fileSize: number;
  inline?: boolean;
  mediaFiles?: { path: string; name: string; size: number }[];
}

export interface HostApi {
  readFile(path: string): Promise<ArrayBuffer>;
  readFileText(path: string): Promise<string>;
  readFileRange?(path: string, offset: number, length: number): Promise<ArrayBuffer>;
  getTheme(): Promise<string>;
  onClose(): void;
}

export interface ViewerExtensionApi {
  mount(props: ViewerProps): Promise<void>;
  unmount(): Promise<void>;
}
