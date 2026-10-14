import { LanguageSetting, useLocale } from './i18n';
import Game from './components/Game.tsx';

import { ToastContainer } from 'react-toastify';
import a16zImg from '../assets/a16z.png';
import convexImg from '../assets/convex.svg';
import starImg from '../assets/star.svg';
import helpImg from '../assets/help.svg';
// import { UserButton } from '@clerk/clerk-react';
// import { Authenticated, Unauthenticated } from 'convex/react';
// import LoginButton from './components/buttons/LoginButton.tsx';
import { useState } from 'react';
import ReactModal from 'react-modal';
import MusicButton from './components/buttons/MusicButton.tsx';
import Button from './components/buttons/Button.tsx';
import InteractButton from './components/buttons/InteractButton.tsx';
import FreezeButton from './components/FreezeButton.tsx';
import { MAX_HUMAN_PLAYERS } from '../convex/constants.ts';
import PoweredByConvex from './components/PoweredByConvex.tsx';
import FederationManager from './components/federation/FederationManager.tsx';

export default function Home() {
  const { t } = useLocale();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [helpModalOpen, setHelpModalOpen] = useState(false);
  const [adminModalOpen, setAdminModalOpen] = useState(false);
  return (
    <main className="town-shell relative flex min-h-screen flex-col items-center justify-between font-body game-background">
      <PoweredByConvex />
      <ReactModal
        isOpen={settingsOpen}
        onRequestClose={() => setSettingsOpen(false)}
        contentLabel={t('Settings')}
        className="federation-modal language-settings font-body"
        overlayClassName="federation-overlay"
        ariaHideApp={false}
      >
        <header className="admin-header">
          <h1 className="font-display">{t('Settings')}</h1>
          <button
            type="button"
            className="admin-close"
            aria-label={t('Close settings')}
            onClick={() => setSettingsOpen(false)}
          >
            ×
          </button>
        </header>
        <section className="admin-panel">
          <LanguageSetting />
          <p className="admin-muted">
            {t('Interface language does not change residents’ conversations or model settings.')}
          </p>
        </section>
      </ReactModal>
      <FederationManager isOpen={adminModalOpen} onClose={() => setAdminModalOpen(false)} />

      <ReactModal
        isOpen={helpModalOpen}
        onRequestClose={() => setHelpModalOpen(false)}
        style={modalStyles}
        contentLabel={t('Help modal')}
        ariaHideApp={false}
      >
        <div className="font-body">
          <h1 className="text-center text-6xl font-bold font-display game-title">{t('Help')}</h1>
          <p>
            {t(
              'Welcome to AI town. AI town supports both anonymous spectators and logged in interactivity.',
            )}
          </p>
          <h2 className="text-4xl mt-4">{t('Spectating')}</h2>
          <p>
            {t(
              'Click and drag to move around the town, and scroll in and out to zoom. You can click on an individual character to view its chat history.',
            )}
          </p>
          <h2 className="text-4xl mt-4">{t('Interactivity')}</h2>
          <p>
            {t(
              'If you log in, you can join the simulation and directly talk to different agents! After logging in, click the "Interact" button, and your character will appear somewhere on the map with a highlighted circle underneath you.',
            )}
          </p>
          <p className="text-2xl mt-2">{t('Controls:')}</p>
          <p className="mt-4">{t('Click to navigate around.')}</p>
          <p className="mt-4">
            {t(
              'To talk to an agent, click on them and then click "Start conversation," which will ask them to start walking towards you. Once they\'re nearby, the conversation will start, and you can speak to each other. You can leave at any time by closing the conversation pane or moving away. They may propose a conversation to you - you\'ll see a button to accept in the messages panel.',
            )}
          </p>
          <p className="mt-4">
            {t(
              "AI town only supports {count} humans at a time. If you're idle for five minutes, you'll be automatically removed from the simulation.",
              { count: MAX_HUMAN_PLAYERS },
            )}
          </p>
        </div>
      </ReactModal>
      {/*<div className="p-3 absolute top-0 right-0 z-10 text-2xl">
        <Authenticated>
          <UserButton afterSignOutUrl="/ai-town" />
        </Authenticated>

        <Unauthenticated>
          <LoginButton />
        </Unauthenticated>
      </div> */}

      <div className="town-layout w-full relative isolate shadow-2xl flex flex-col justify-start">
        <h1 className="town-heading mx-auto font-bold font-display leading-none tracking-wide game-title text-center">
          {t('AI Town')}
        </h1>

        <div className="town-intro mx-auto text-center text-white leading-tight shadow-solid">
          {t('A virtual town where AI characters live, chat and socialize.')}
          {/* <Unauthenticated>
            <div className="my-1.5 sm:my-0" />
            Log in to join the town
            <br className="block sm:hidden" /> and the conversation!
          </Unauthenticated> */}
        </div>

        <div className="town-controls justify-end w-full flex items-center gap-2 flex-wrap pointer-events-none">
          <div className="flex flex-wrap gap-2 flex-grow pointer-events-none">
            <button
              type="button"
              className="button text-white shadow-solid text-xl pointer-events-auto"
              onClick={() => setSettingsOpen(true)}
            >
              <span className="bg-clay-700">{t('Settings')}</span>
            </button>
            <FreezeButton />
            <MusicButton />
            <Button href="https://github.com/a16z-infra/ai-town" imgUrl={starImg}>
              {t('Star')}
            </Button>
            <InteractButton />
            <Button imgUrl={helpImg} onClick={() => setHelpModalOpen(true)}>
              {t('Help')}
            </Button>
            <button
              type="button"
              className="button text-white shadow-solid text-xl pointer-events-auto"
              onClick={() => setAdminModalOpen(true)}
            >
              <span className="bg-clay-700">{t('Town admin')}</span>
            </button>
          </div>
          <a href="https://a16z.com">
            <img className="w-8 h-8 pointer-events-auto" src={a16zImg} alt="a16z" />
          </a>
          <a href="https://convex.dev/c/ai-town">
            <img className="w-20 h-8 pointer-events-auto" src={convexImg} alt="Convex" />
          </a>
        </div>
        <Game />
        <ToastContainer position="bottom-right" autoClose={2000} closeOnClick theme="dark" />
      </div>
    </main>
  );
}

const modalStyles = {
  overlay: {
    backgroundColor: 'rgb(0, 0, 0, 75%)',
    zIndex: 12,
  },
  content: {
    top: '50%',
    left: '50%',
    right: 'auto',
    bottom: 'auto',
    marginRight: '-50%',
    transform: 'translate(-50%, -50%)',
    width: 'calc(100vw - 32px)',
    maxWidth: '720px',
    maxHeight: 'calc(100dvh - 32px)',

    border: '10px solid rgb(23, 20, 33)',
    borderRadius: '0',
    background: 'rgb(35, 38, 58)',
    color: 'white',
    fontFamily: '"Upheaval Pro", "sans-serif"',
  },
};
