import { httpRouter } from 'convex/server';
import { handleReplicateWebhook } from './music';
import { registerFederationRoutes } from './federation/transport';
import { registerPairingRoutes } from './federation/peers';
import { registerMigrationRoutes } from './federation/migration';
import { registerEndpointRoutes } from './federation/endpoints';
import { registerCredentialRotationRoutes } from './federation/peerCredentialRotation';
import { registerIdentityKeyRoutes } from './federation/identityKeyRotation';
import { registerCapacityRoutes } from './federation/capacity';

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
registerCredentialRotationRoutes(http);
registerIdentityKeyRoutes(http);
registerCapacityRoutes(http);
export default http;
