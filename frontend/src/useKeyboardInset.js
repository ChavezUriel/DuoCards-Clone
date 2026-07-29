// Soft-keyboard tracking for the locked review layout. useKeyboardInset() watches the
// visualViewport and publishes three things on <html> for styles.css to react to:
//
//   --kb-inset      how much of the *layout* viewport the keyboard overlays (iOS)
//   data-kb-open    the keyboard is up
//   data-kb-tight   ...and what's left is too short for the merely-compact layout
//
// Why JS and not just CSS: browsers split into two behaviours and neither is fully
// expressible in CSS. The viewport `interactive-widget=resizes-content` meta
// (index.html) makes Chromium/Android shrink the layout viewport itself — 100dvh is
// then already correct and `--kb-inset` must stay 0 or we'd subtract the keyboard
// twice. iOS Safari ignores that meta and overlays the keyboard on a full-height page,
// so the layout viewport (window.innerHeight) stays tall while visualViewport.height
// shrinks, and the difference is exactly the slice to reclaim. dvh units and
// `max-height` media queries can't see that slice at all, which is why the compaction
// tiers hang off attributes instead of a height query.
//
// `data-kb-open` therefore can NOT be derived from `--kb-inset`: on the resizes-content
// path the inset is 0 while the keyboard very much is up. Both paths do shrink the
// *visual* viewport, so that shrink — measured against the tallest height seen for the
// current orientation — is the portable signal.
import { useEffect } from 'react';

// The viewport has to lose at least this much height before we call it a keyboard.
// Keeps us from mistaking the URL-bar collapse or sub-pixel rounding for one (a real
// on-screen keyboard is far taller than this).
const KEYBOARD_THRESHOLD_PX = 140;

// Below this much usable height the games switch to their tight tier: input and action
// share a row, the secondary Spanish example goes, and the type eases down a step.
// Sized off the tallest tier-1 layout — recall from definition, which needs ~360px for a
// three-line definition, hint, input and action — plus headroom for longer content.
const TIGHT_AVAIL_PX = 460;

// A width change this large is a rotation (or a real window resize), not a reflow, and
// the no-keyboard baseline height has to be re-learned for the new orientation.
const ORIENTATION_WIDTH_DELTA_PX = 40;

// True while the focused element is something a soft keyboard would have opened for.
// Pairing this with the viewport shrink is what makes the signal mean "soft keyboard",
// not "small window": a desktop browser resized below the threshold with nothing
// focused never trips it.
function isEditableFocused() {
  const active = document.activeElement;
  if (!active || active === document.body) {
    return false;
  }
  const tag = active.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || active.isContentEditable;
}

// The whole decision, as arithmetic over one measurement plus the running baseline —
// pulled out of the effect so it can be reasoned about (and exercised) without a DOM.
// `previous` is the state this returns; feed it back on the next measurement.
//
// `measurement`: { layoutWidth, layoutHeight, viewportHeight, scale, editableFocused }
// — layout* from window.inner*, viewport* from visualViewport, editableFocused from the
// active element. Returns { baseline, baselineWidth, inset, open, tight }.
export function keyboardState(measurement, previous) {
  const { layoutWidth, layoutHeight, viewportHeight, scale, editableFocused } = measurement;
  let { baseline, baselineWidth } = previous;

  // Pinch-zoom shrinks the visual viewport for reasons that aren't a keyboard. Leave
  // the baseline alone (it's still valid) and report nothing.
  if (scale > 1.01) {
    return { baseline, baselineWidth, inset: 0, open: false, tight: false };
  }

  // Rotating (or resizing a desktop window sideways) invalidates the baseline. Only a
  // substantial width change counts — a rotation moves it by hundreds of pixels.
  if (Math.abs(layoutWidth - baselineWidth) > ORIENTATION_WIDTH_DELTA_PX) {
    baselineWidth = layoutWidth;
    baseline = viewportHeight;
  } else if (viewportHeight > baseline) {
    baseline = viewportHeight;
  }

  // Overlay slice: the part of the layout viewport hidden behind the keyboard.
  // Scroll-independent (visualViewport.offsetTop only pans within the visible region, it
  // doesn't change its size), so it stays stable as iOS scrolls the focused input into
  // view. ~0 where the layout viewport shrinks in lockstep, which is what keeps the two
  // mechanisms from double-counting.
  const overlay = layoutHeight - viewportHeight;
  const open = baseline - viewportHeight > KEYBOARD_THRESHOLD_PX && editableFocused;

  return {
    baseline,
    baselineWidth,
    // Gated on `open` so the shrunken shell and the compact layout can never disagree.
    // They come apart on every answer otherwise: submitting disables the input, which
    // blurs it, and for the ~250ms the keyboard takes to slide away the viewport is
    // still short — a full-size card in a shrunken shell, i.e. clipped.
    inset: open && overlay > KEYBOARD_THRESHOLD_PX ? Math.round(overlay) : 0,
    open,
    tight: open && viewportHeight < TIGHT_AVAIL_PX,
  };
}

export function useKeyboardInset() {
  useEffect(() => {
    const viewport = window.visualViewport;
    const root = document.documentElement;
    if (!viewport) {
      return undefined;
    }

    let frame = 0;
    // Tallest visual viewport seen since the last orientation change, i.e. the height
    // with no keyboard up. Grows on its own as the URL bar collapses or the keyboard
    // closes, so it self-corrects if the page happens to mount with a keyboard already
    // showing. Keyed on the LAYOUT width, which a keyboard never changes:
    // visualViewport.width moves by a scrollbar's worth when the page starts or stops
    // overflowing, and reading that as a rotation would reset the baseline to the shrunk
    // height and hide the keyboard from us entirely.
    let state = { baseline: viewport.height, baselineWidth: window.innerWidth };

    function apply() {
      frame = 0;
      state = keyboardState(
        {
          layoutWidth: window.innerWidth,
          layoutHeight: window.innerHeight,
          viewportHeight: viewport.height,
          scale: viewport.scale,
          editableFocused: isEditableFocused(),
        },
        state,
      );

      root.style.setProperty('--kb-inset', `${state.inset}px`);
      root.toggleAttribute('data-kb-open', state.open);
      root.toggleAttribute('data-kb-tight', state.tight);
    }

    function schedule() {
      if (!frame) {
        frame = window.requestAnimationFrame(apply);
      }
    }

    viewport.addEventListener('resize', schedule);
    viewport.addEventListener('scroll', schedule);
    // Focus moves without a resize when one input hands off to another, and on Android
    // the keyboard can be dismissed while the input keeps focus — recheck on both.
    window.addEventListener('focusin', schedule);
    window.addEventListener('focusout', schedule);
    apply();

    return () => {
      viewport.removeEventListener('resize', schedule);
      viewport.removeEventListener('scroll', schedule);
      window.removeEventListener('focusin', schedule);
      window.removeEventListener('focusout', schedule);
      if (frame) {
        window.cancelAnimationFrame(frame);
      }
      root.style.removeProperty('--kb-inset');
      root.removeAttribute('data-kb-open');
      root.removeAttribute('data-kb-tight');
    };
  }, []);
}
