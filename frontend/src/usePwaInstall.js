import { useCallback, useEffect, useState } from 'react';

// Was the app launched from an installed (home-screen) instance?
function getIsStandalone() {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    window.navigator.standalone === true // iOS Safari
  );
}

function detectIOS() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const iOS = /iPad|iPhone|iPod/.test(ua);
  // iPadOS 13+ reports as Mac; sniff touch support to catch it.
  const iPadOS = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  return iOS || iPadOS;
}

/**
 * Manages Progressive Web App installation.
 *
 * Returns:
 *  - canInstall: a native install prompt is available (Chrome/Edge/Android).
 *  - isStandalone: already running as an installed app — hide the CTA.
 *  - isIOS: needs the manual "Share → Add to Home Screen" flow (no prompt event).
 *  - promptInstall(): fire the native prompt; resolves to true if accepted.
 */
export default function usePwaInstall() {
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [isStandalone, setIsStandalone] = useState(getIsStandalone);
  const [isIOS] = useState(detectIOS);

  useEffect(() => {
    const onBeforeInstall = (event) => {
      // Stop Chrome's mini-infobar; we drive the prompt from our own button.
      event.preventDefault();
      setDeferredPrompt(event);
    };
    const onInstalled = () => {
      setDeferredPrompt(null);
      setIsStandalone(true);
    };

    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    window.addEventListener('appinstalled', onInstalled);

    // Keep isStandalone in sync if the user installs and the mode flips.
    const mql = window.matchMedia?.('(display-mode: standalone)');
    const onDisplayChange = (e) => setIsStandalone(e.matches);
    mql?.addEventListener?.('change', onDisplayChange);

    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('appinstalled', onInstalled);
      mql?.removeEventListener?.('change', onDisplayChange);
    };
  }, []);

  const promptInstall = useCallback(async () => {
    if (!deferredPrompt) return false;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    // A prompt can only be used once; drop it whatever the outcome.
    setDeferredPrompt(null);
    return outcome === 'accepted';
  }, [deferredPrompt]);

  return {
    canInstall: Boolean(deferredPrompt),
    isStandalone,
    isIOS,
    promptInstall,
  };
}
