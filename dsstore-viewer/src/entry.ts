import type { ViewerExtensionApi, ViewerProps } from './types';
import { mountViewer, unmountViewer } from './viewer';

function createExtensionApi(): ViewerExtensionApi {
  let mounted = false;
  return {
    async mount(root: HTMLElement, props: ViewerProps): Promise<void> {
      if (mounted) unmountViewer();
      await mountViewer(root, props);
      mounted = true;
    },
    async unmount(): Promise<void> {
      if (!mounted) return;
      unmountViewer();
      mounted = false;
    },
  };
}

export default createExtensionApi();
