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
if (typeof window !== 'undefined' && (window as Window & { __faradayHostReady?: (api: ViewerExtensionApi) => void }).__faradayHostReady) {
  (window as Window & { __faradayHostReady: (api: ViewerExtensionApi) => void }).__faradayHostReady(api);
}
