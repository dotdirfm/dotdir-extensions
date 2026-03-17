import type { ViewerExtensionApi, ViewerProps, HostApi } from './types';
import { mountViewer, unmountViewer } from './viewer';

function createExtensionApi(): ViewerExtensionApi {
  let mounted = false;
  return {
    async mount(root: HTMLElement, hostApi: HostApi, props: ViewerProps): Promise<void> {
      if (mounted) unmountViewer();
      await mountViewer(root, hostApi, props);
      mounted = true;
    },
    async unmount(): Promise<void> {
      if (!mounted) return;
      unmountViewer();
      mounted = false;
    },
  };
}

const api = createExtensionApi();
const w = window as unknown as Window & { __faradayHostReady?: (api: ViewerExtensionApi) => void };
if (typeof window !== 'undefined' && w.__faradayHostReady) {
  w.__faradayHostReady(api);
}

