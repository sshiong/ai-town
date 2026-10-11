import React from 'react';
import { LocaleProvider, useLocale } from './i18n';
import ReactDOM from 'react-dom/client';
const Home = React.lazy(() => import('./App.tsx'));
import './index.css';
import 'uplot/dist/uPlot.min.css';
import 'react-toastify/dist/ReactToastify.css';
import ConvexClientProvider from './components/ConvexClientProvider.tsx';

function LoadingTown() {
  const { t } = useLocale();
  return (
    <p className="admin-panel font-body" role="status">
      {t('Loading the town…')}
    </p>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <LocaleProvider>
      <ConvexClientProvider>
        <React.Suspense fallback={<LoadingTown />}>
          <Home />
        </React.Suspense>
      </ConvexClientProvider>
    </LocaleProvider>
  </React.StrictMode>,
);
