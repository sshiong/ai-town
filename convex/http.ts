import { httpRouter } from 'convex/server';
import { handleReplicateWebhook } from './music';
import { registerFederationRoutes } from './federation/transport';
import { registerPairingRoutes } from './federation/peers';
import { registerMigrationRoutes } from './federation/migration';
import { registerEndpointRoutes } from './federation/endpoints';

const http = httpRouter();
http.route({
  path: '/replicate_webhook',
  method: 'POST',
  handler: handleReplicateWebhook,
});
registerFederationRoutes(http);
registerPairingRoutes(http);
registerMigrationRoutes(http);
registerEndpointRoutes(http);
export default http;
