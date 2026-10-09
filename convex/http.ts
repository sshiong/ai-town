import { httpRouter } from 'convex/server';
import { handleReplicateWebhook } from './music';
import { registerFederationRoutes } from './federation/transport';
import { registerPairingRoutes } from './federation/peers';

const http = httpRouter();
http.route({
  path: '/replicate_webhook',
  method: 'POST',
  handler: handleReplicateWebhook,
});
registerFederationRoutes(http);
registerPairingRoutes(http);
export default http;
