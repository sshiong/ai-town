import { Component, ReactNode } from 'react';
import { ConvexReactClient, ConvexProvider, useConvexConnectionState } from 'convex/react';
import { LanguageSetting, useLocale } from '../i18n';
// import { ConvexProviderWithClerk } from 'convex/react-clerk';
// import { ClerkProvider, useAuth } from '@clerk/clerk-react';

const deploymentUrl = import.meta.env.VITE_CONVEX_URL as string | undefined;
let convex: ConvexReactClient | undefined;
let configurationError: string | undefined;
try {
  if (!deploymentUrl) throw new Error('VITE_CONVEX_URL is missing.');
  const url = new URL(deploymentUrl);
  if (!['http:', 'https:'].includes(url.protocol))
    throw new Error('VITE_CONVEX_URL must be an HTTP or HTTPS deployment URL.');
  convex = new ConvexReactClient(deploymentUrl, { unsavedChangesWarning: false });
} catch (error) {
  configurationError = error instanceof Error ? error.message : 'Invalid deployment configuration.';
}

function ServiceError({ error, retry }: { error: Error; retry: () => void }) {
  const { t } = useLocale();
  return (
    <div className="admin-panel font-body admin-recovery" role="alert">
      <h2>{t('Town service unavailable')}</h2>
      <p>
        {t(
          'The server could not load this view. Check the deployment and server logs, then retry.',
        )}
      </p>
      <p className="admin-error">{error.message}</p>
      <button type="button" className="admin-button button" onClick={retry}>
        <span>{t('Retry view')}</span>
      </button>
    </div>
  );
}
export class TownErrorBoundary extends Component<{ children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error)
      return (
        <ServiceError error={this.state.error} retry={() => this.setState({ error: undefined })} />
      );
    return this.props.children;
  }
}
function ConnectionNotice() {
  const { t } = useLocale();
  const connection = useConvexConnectionState();
  if (connection.isWebSocketConnected) return null;
  return (
    <div className="town-connection font-body" role="status">
      {t('Connecting to the town server…')}{' '}
      {connection.connectionRetries > 0 &&
        t(
          'Connection interrupted. Check the deployment URL and network; pending operations are waiting for the server.',
        )}
    </div>
  );
}
export default function ConvexClientProvider({ children }: { children: ReactNode }) {
  const { t } = useLocale();
  if (!convex)
    return (
      <main className="game-background deployment-screen font-body">
        <section className="federation-modal admin-panel">
          <p className="admin-eyebrow">{t('AI Town · Deployment setup')}</p>
          <h1 className="font-display game-title">{t('Your town awaits')}</h1>
          <LanguageSetting />
          <h2>{t('Connect the town server')}</h2>
          <p role="alert" className="admin-error">
            {configurationError}
          </p>
          <p>
            {t(
              'Add the Convex deployment URL as VITE_CONVEX_URL in your frontend environment, then restart the frontend.',
            )}
          </p>
          <p className="admin-muted">
            {t(
              "Initialize the backend world before opening the map. Federation administration also requires the server's FEDERATION_ADMIN_TOKEN. No world data is loaded until a server is configured.",
            )}
          </p>
          <a
            className="admin-doc-link"
            href="https://github.com/a16z-infra/ai-town#readme"
            target="_blank"
            rel="noreferrer"
          >
            {t('Read deployment instructions ↗')}
          </a>
        </section>
      </main>
    );
  return (
    <ConvexProvider client={convex}>
      <ConnectionNotice />
      <TownErrorBoundary>{children}</TownErrorBoundary>
    </ConvexProvider>
  );
}
