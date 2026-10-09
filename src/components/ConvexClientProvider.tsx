import { Component, ReactNode } from 'react';
import { ConvexReactClient, ConvexProvider, useConvexConnectionState } from 'convex/react';
// import { ConvexProviderWithClerk } from 'convex/react-clerk';
// import { ClerkProvider, useAuth } from '@clerk/clerk-react';

/**
 * Determines the Convex deployment to use.
 *
 * We perform load balancing on the frontend, by randomly selecting one of the available instances.
 * We use localStorage so that individual users stay on the same instance.
 */
const deploymentUrl = import.meta.env.VITE_CONVEX_URL as string | undefined;
let convex: ConvexReactClient | undefined;
let configurationError: string | undefined;
try {
  if (!deploymentUrl) throw new Error('VITE_CONVEX_URL is missing.');
  const url = new URL(deploymentUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('VITE_CONVEX_URL must be an HTTP or HTTPS deployment URL.');
  convex = new ConvexReactClient(deploymentUrl, { unsavedChangesWarning: false });
} catch (error) {
  configurationError = error instanceof Error ? error.message : 'Invalid deployment configuration.';
}

export class TownErrorBoundary extends Component<{ children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (this.state.error) return <div className="admin-panel font-body admin-recovery" role="alert"><h2>Town service unavailable</h2><p>The server could not load this view. Check the deployment and server logs, then retry.</p><p className="admin-error">{this.state.error.message}</p><button type="button" className="admin-button button" onClick={() => this.setState({ error: undefined })}><span>Retry view</span></button></div>;
    return this.props.children;
  }
}

function ConnectionNotice() {
  const connection = useConvexConnectionState();
  if (connection.isWebSocketConnected) return null;
  return <div className="town-connection font-body" role="status">Connecting to the town server… {connection.connectionRetries > 0 && 'Connection interrupted. Check the deployment URL and network; pending operations are waiting for the server.'}</div>;
}

export default function ConvexClientProvider({ children }: { children: ReactNode }) {
  if (!convex) return <main className="game-background deployment-screen font-body"><section className="federation-modal admin-panel"><p className="admin-eyebrow">AI Town · Deployment setup</p><h1 className="font-display game-title">Your town awaits</h1><h2>Connect the town server</h2><p role="alert" className="admin-error">{configurationError}</p><p>Add the Convex deployment URL as <code>VITE_CONVEX_URL</code> in your frontend environment, then restart the frontend.</p><p className="admin-muted">Initialize the backend world before opening the map. Federation administration also requires the server's FEDERATION_ADMIN_TOKEN. No world data is loaded until a server is configured.</p><a className="admin-doc-link" href="https://github.com/a16z-infra/ai-town#readme" target="_blank" rel="noreferrer">Read deployment instructions ↗</a></section></main>;
  return (
    // <ClerkProvider publishableKey={import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string}>
    // <ConvexProviderWithClerk client={convex} useAuth={useAuth}>
    <ConvexProvider client={convex}><ConnectionNotice /><TownErrorBoundary>{children}</TownErrorBoundary></ConvexProvider>
    // </ConvexProviderWithClerk>
    // </ClerkProvider>
  );
}
