import { useEffect } from 'react';

// The soft keyboard has to eat at least this much of the viewport before we react.
// Keeps us from mistaking the iOS URL-bar collapse or sub-pixel rounding for a
// keyboard (a real on-screen keyboard is far taller than this).
const KEYBOARD_THRESHOLD_PX = 140;

// Tracks the on-screen keyboard through the visualViewport API and exposes how much
// of the viewport it covers as the `--kb-inset` CSS variable on <html>, plus a
// `data-kb-open` flag while it's up. The locked review shell subtracts `--kb-inset`
// from its height (styles.css) so an active minigame — especially the text-input
// ones — keeps its prompt, input and actions above the keyboard instead of behind it.
//
// Why JS and not just CSS: the viewport `interactive-widget=resizes-content` meta
// (index.html) already shrinks the layout viewport on Chromium, but iOS Safari
// ignores it and overlays the keyboard on a full-height page. There the layout
// viewport (window.innerHeight) stays tall while visualViewport.height shrinks, and
// the difference is exactly the slice we need to reclaim. On browsers that DO honor
// resizes-content, window.innerHeight shrinks in lockstep with visualViewport.height,
// so the computed inset is ~0 and the two mechanisms compose without double-counting.
export function useKeyboardInset() {
  useEffect(() => {
    const viewport = window.visualViewport;
    const root = document.documentElement;
    if (!viewport) {
      return undefined;
    }

    let frame = 0;

    function apply() {
      frame = 0;
      // Keyboard height = layout-viewport height minus the visible height. This is
      // scroll-independent (offsetTop only pans within the visible region, it doesn't
      // change its size), so the inset stays stable as iOS scrolls the focused input
      // into view. Skip while pinch-zoomed, where the same delta isn't a keyboard.
      const covered = window.innerHeight - viewport.height;
      const zoomed = viewport.scale > 1.01;
      const inset = !zoomed && covered > KEYBOARD_THRESHOLD_PX ? Math.round(covered) : 0;
      root.style.setProperty('--kb-inset', `${inset}px`);
      if (inset > 0) {
        root.setAttribute('data-kb-open', '');
      } else {
        root.removeAttribute('data-kb-open');
      }
    }

    function schedule() {
      if (!frame) {
        frame = window.requestAnimationFrame(apply);
      }
    }

    viewport.addEventListener('resize', schedule);
    viewport.addEventListener('scroll', schedule);
    apply();

    return () => {
      viewport.removeEventListener('resize', schedule);
      viewport.removeEventListener('scroll', schedule);
      if (frame) {
        window.cancelAnimationFrame(frame);
      }
      root.style.removeProperty('--kb-inset');
      root.removeAttribute('data-kb-open');
    };
  }, []);
}
