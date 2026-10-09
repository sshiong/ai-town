import React from 'react';
import ReactDOM from 'react-dom/client';
const Home = React.lazy(() => import('./App.tsx'));
import './index.css';
import 'uplot/dist/uPlot.min.css';
import 'react-toastify/dist/ReactToastify.css';
import ConvexClientProvider from './components/ConvexClientProvider.tsx';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConvexClientProvider>
      <React.Suspense fallback={<p className="admin-panel font-body" role="status">Loading the town…</p>}><Home /></React.Suspense>
    </ConvexClientProvider>
  </React.StrictMode>,
);
