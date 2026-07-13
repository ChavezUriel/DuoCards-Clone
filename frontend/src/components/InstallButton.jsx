import React, { useEffect, useRef, useState } from 'react';
import usePwaInstall from '../usePwaInstall';

const DownloadIcon = () => (
  <svg className="install-button__icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path
      d="M12 3v10m0 0 4-4m-4 4-4-4M5 17v2a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-2"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const ShareIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" width="18" height="18">
    <path
      d="M12 3v11m0-11 3.5 3.5M12 3 8.5 6.5M6 11H5a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7a1 1 0 0 0-1-1h-1"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/**
 * Header CTA that installs Heron as a Progressive Web App.
 * - Android / desktop Chrome: fires the native install prompt.
 * - iOS Safari (no prompt event): shows the manual "Add to Home Screen" steps.
 * - Already installed / unsupported browsers: renders nothing.
 */
export default function InstallButton() {
  const { canInstall, isStandalone, isIOS, promptInstall } = usePwaInstall();
  const [showIosHelp, setShowIosHelp] = useState(false);
  const wrapRef = useRef(null);

  // Dismiss the iOS help popover on outside click or Escape.
  useEffect(() => {
    if (!showIosHelp) return undefined;
    const onPointerDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setShowIosHelp(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setShowIosHelp(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [showIosHelp]);

  // Nothing to offer: installed already, or a browser with no install path.
  if (isStandalone || (!canInstall && !isIOS)) return null;

  const handleClick = () => {
    if (canInstall) {
      promptInstall();
    } else {
      setShowIosHelp((v) => !v);
    }
  };

  return (
    <div className="install-button-wrap" ref={wrapRef}>
      <button
        type="button"
        className="install-button"
        onClick={handleClick}
        aria-haspopup={isIOS ? 'dialog' : undefined}
        aria-expanded={isIOS ? showIosHelp : undefined}
        title="Install Heron on your device"
      >
        <DownloadIcon />
        <span>Get the app</span>
      </button>

      {isIOS && showIosHelp && (
        <div className="install-help" role="dialog" aria-label="How to install Heron">
          <p className="install-help__title">Add Heron to your Home Screen</p>
          <ol className="install-help__steps">
            <li>
              Tap the <strong>Share</strong> icon <ShareIcon /> in Safari's toolbar.
            </li>
            <li>
              Choose <strong>Add to Home Screen</strong>.
            </li>
            <li>
              Tap <strong>Add</strong> — Heron opens like a native app.
            </li>
          </ol>
        </div>
      )}
    </div>
  );
}
