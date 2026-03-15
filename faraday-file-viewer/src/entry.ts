import * as Comlink from 'comlink';
import type { ViewerExtensionApi, ViewerProps, HostApi } from './types';
import { mountViewer, unmountViewer } from './viewer';

const handshakeId =
  typeof window !== 'undefined' && (window as unknown as { __faradayHandshakeId?: string }).__faradayHandshakeId;

const postToHost = (msg: object, transfer?: Transferable[]) => {
  if (typeof parent !== 'undefined') parent.postMessage(msg, '*', transfer);
  else (window as Window).postMessage(msg, '*', transfer);
};

if (!handshakeId) {
  postToHost({ type: 'faraday-error', message: 'Missing __faradayHandshakeId' });
  throw new Error('Faraday extension: missing handshake id');
}

postToHost({ type: 'faraday-loaded', handshakeId });

function createExtensionApi(hostApi: HostApi): ViewerExtensionApi {
  let mounted = false;
  return {
    async mount(props: ViewerProps): Promise<void> {
      if (mounted) unmountViewer();
      await mountViewer(hostApi, props);
      mounted = true;
    },
    async unmount(): Promise<void> {
      if (!mounted) return;
      unmountViewer();
      mounted = false;
    },
  };
}

window.addEventListener('message', (event: MessageEvent) => {
  if (event.data?.type !== 'faraday-init' || event.data?.handshakeId !== handshakeId) return;
  const port: MessagePort = event.data.port;
  if (!port) return;

  const hostApi = Comlink.wrap<HostApi>(port);
  const extensionApi = createExtensionApi(hostApi);
  const { port1, port2 } = new MessageChannel();
  Comlink.expose(extensionApi, port1);
  postToHost({ type: 'faraday-ready', port: port2, handshakeId }, [port2]);
});
