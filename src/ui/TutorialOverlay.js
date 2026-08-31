/**
 * The guided tour: a dimmed page with one thing left lit, and a card explaining it.
 *
 * Walks the list in ui/tutorialSteps.js and knows nothing about any particular step --
 * which control a card points at, and what it dials in, are that file's to say.
 *
 * ---- Why the dim is four rectangles ----
 *
 * The obvious build is one full-viewport scrim plus a hole punched with
 * `box-shadow: 0 0 0 9999px`, with the target lifted above it by `position: relative;
 * z-index`. That does not work in this app. `header`, `.infobar` and `.scrollind` are
 * each `position: fixed`/`sticky` with `z-index: 10`, so each is its own stacking
 * context -- a raised Play button would stay trapped inside the header's context and
 * paint *underneath* the scrim however high its own z-index went.
 *
 * So the dim is four fixed panels tiled around the target instead:
 *
 *     +------------------ top ------------------+
 *     +------+-------------------------+--------+
 *     | left |       the target        | right  |
 *     +------+-------------------------+--------+
 *     +----------------- bottom ----------------+
 *
 * Nothing is ever painted over the target, so it stays visible and operable at its own
 * natural z-index -- no position override, no stacking-context problem, and it behaves
 * the same whether the target is a canvas, a header button or the fixed footer. The
 * four panels swallow pointer events, which is what makes the rest of the page inert.
 * The ring around the hole is a separate `pointer-events: none` element, decoration
 * only.
 *
 * ---- What stays live ----
 *
 * The spotlit control. That is the point of the tour driving the instrument rather
 * than describing it: a card sets Steps to 8 and the reader can immediately drag it to
 * 5 and hear the difference, without leaving the card. Which is also why this dialog
 * does NOT set `aria-modal` -- the page behind it is deliberately not inert, and
 * claiming otherwise would be a lie to a screen reader. Arrow keys move between cards
 * only while focus is inside the card, so they keep nudging values when focus is on
 * the control being described. Escape always closes.
 */

/** Breathing room between the target's edge and the hole's, in px. */
const PAD = 6;
/** Between the hole and the card, and between the card and the viewport edge. */
const GAP = 14;
/** Below this the card is docked to an edge rather than placed beside the hole. */
const NARROW_PX = 640;
/**
 * A hole shorter than this is not worth showing: it is a sliver of a control rather
 * than the control. Reaching it means the card and the target cannot both fit, which
 * is what the corrective scroll in #layout exists to resolve.
 */
const MIN_HOLE_PX = 44;

export class TutorialOverlay {
  /**
   * Side effects arrive as callbacks rather than imports, the way every other widget
   * here takes its dependencies -- so a check page can drive the whole tour without a
   * bootstrap, an audio context or a scheduler.
   *
   * @param {object} opts
   * @param {ReadonlyArray<object>} opts.steps from ui/tutorialSteps.js
   * @param {(key: string, value: any, trackId: number) => void} opts.setParam asked to
   *   change a parameter; in the app this emits `param:change` like any control, so the
   *   store stays the one thing that decides what actually happens
   * @param {(trackId: number) => void} [opts.selectTrack] bring a track's page on screen
   * @param {() => (void | Promise<void>)} [opts.start] start the transport
   * @param {() => void} [opts.toggleTransport] start it if stopped, stop it if running;
   *   what the space bar does, which the tour has to route itself while it holds focus
   * @param {() => void} [opts.onOpen] stage the instrument for card 1, before any card
   *   has run. Separate from the steps because it is not a step: it runs once per
   *   opening, and what it does is the app's business, not this widget's
   * @param {HTMLElement} [opts.anchor] what opened the tour; focus returns here on close
   * @param {Document} [opts.doc] for a check page that builds its own document
   */
  constructor({
    steps, setParam, selectTrack, start, toggleTransport, onOpen, anchor, doc = document,
  }) {
    this.steps = steps;
    this.setParam = setParam;
    this.selectTrack = selectTrack;
    this.start = start;
    this.toggleTransport = toggleTransport;
    this.onOpen = onOpen;
    this.anchor = anchor ?? null;
    this.doc = doc;

    /** Which card is showing, or -1 when the tour is closed. */
    this.index = -1;
    /** @type {Element | null} */
    this.target = null;
    /** Coalesces a burst of scroll/resize callbacks into one layout per frame. */
    this.frameId = 0;
    /**
     * Whether this card has already had its one corrective scroll -- see #layout.
     * Per card, so moving on offers the next one a fresh attempt, and never more than
     * once, so a page that cannot scroll far enough is not asked twice a frame.
     */
    this.corrected = false;
    /**
     * Ids of the cards whose `set` has already run this opening -- see #goTo. Cleared
     * on open, so a second tour demonstrates everything again from the top.
     * @type {Set<string>}
     */
    this.applied = new Set();
    /**
     * Ids of the cards whose offer to start the transport has been kept -- see
     * #keepPromise. Separate from `applied` because it is spent at a different moment:
     * `set` runs on arrival, `play` on departure.
     * @type {Set<string>}
     */
    this.promised = new Set();

    this.#build();

    // Bound once so add/removeEventListener see the same function object.
    this.onReflow = () => this.#scheduleLayout();
    this.onKeyDown = (e) => this.#onKeyDown(e);
    this.observer = typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => this.#scheduleLayout())
      : null;
  }

  get isOpen() {
    return this.index >= 0;
  }

  #build() {
    const { doc } = this;
    this.element = doc.createElement('div');
    this.element.className = 'tutorial';
    // A dialog, but not aria-modal -- see the header. The page behind is partly live
    // on purpose, so saying it is inert would be false.
    this.element.setAttribute('role', 'dialog');
    this.element.setAttribute('aria-label', 'Tutorial');

    /** top, right, bottom, left -- the four panels that make up the dim. */
    this.masks = ['top', 'right', 'bottom', 'left'].map((side) => {
      const el = doc.createElement('div');
      el.className = `tutorial__mask tutorial__mask--${side}`;
      // Swallowed rather than ignored: while the tour is up, the only control that
      // responds is the one in the hole.
      el.addEventListener('pointerdown', (e) => e.preventDefault());
      this.element.appendChild(el);
      return el;
    });

    this.ringEl = doc.createElement('div');
    this.ringEl.className = 'tutorial__ring';
    this.element.appendChild(this.ringEl);

    this.cardEl = doc.createElement('div');
    this.cardEl.className = 'tutorial__card';
    this.cardEl.tabIndex = -1;

    const head = doc.createElement('div');
    head.className = 'tutorial__head';
    this.chapterEl = doc.createElement('span');
    this.chapterEl.className = 'tutorial__chapter';
    this.countEl = doc.createElement('span');
    this.countEl.className = 'tutorial__count';
    this.closeEl = doc.createElement('button');
    this.closeEl.type = 'button';
    this.closeEl.className = 'tutorial__close';
    this.closeEl.setAttribute('aria-label', 'Close tutorial');
    this.closeEl.textContent = '✕';
    this.closeEl.addEventListener('click', () => this.close());
    head.append(this.chapterEl, this.countEl, this.closeEl);

    this.titleEl = doc.createElement('h2');
    this.titleEl.className = 'tutorial__title';
    this.bodyEl = doc.createElement('p');
    this.bodyEl.className = 'tutorial__body';
    // The copy is what changes on every card, so it is what a screen reader should
    // hear -- the chapter and count above it are chrome.
    this.bodyEl.setAttribute('aria-live', 'polite');

    const foot = doc.createElement('div');
    foot.className = 'tutorial__foot';
    this.skipEl = doc.createElement('button');
    this.skipEl.type = 'button';
    this.skipEl.className = 'tutorial__skip';
    this.skipEl.textContent = 'Skip chapter';
    this.skipEl.addEventListener('click', () => this.skipChapter());
    this.backEl = doc.createElement('button');
    this.backEl.type = 'button';
    this.backEl.className = 'tutorial__back';
    this.backEl.textContent = '‹ Back';
    this.backEl.addEventListener('click', () => this.back());
    this.nextEl = doc.createElement('button');
    this.nextEl.type = 'button';
    this.nextEl.className = 'tutorial__next primary';
    this.nextEl.addEventListener('click', () => this.next());
    foot.append(this.skipEl, this.backEl, this.nextEl);

    this.cardEl.append(head, this.titleEl, this.bodyEl, foot);
    this.element.appendChild(this.cardEl);
  }

  // -------------------------------------------------------------------------
  // Opening, closing, moving
  // -------------------------------------------------------------------------

  open(index = 0) {
    if (this.isOpen) return;
    // Before anything is on screen, so the reader never sees the arrangement being
    // rearranged. Opening at a later card still stages: the copy from card 1 onwards
    // assumes one voice playing, wherever the reader joins it.
    this.onOpen?.();
    this.applied.clear();
    this.promised.clear();
    this.doc.body.appendChild(this.element);
    // Capture, because a scroll inside the control panel does not bubble to window.
    // Passive, because this only measures.
    window.addEventListener('scroll', this.onReflow, { capture: true, passive: true });
    window.addEventListener('resize', this.onReflow);
    window.addEventListener('keydown', this.onKeyDown);
    // The page's own layout moves without any of those firing -- selecting a track
    // swaps the whole control panel. Same reason ScrollIndicator watches the body.
    this.observer?.observe(this.doc.body);
    this.#goTo(index);
    this.cardEl.focus();
  }

  close() {
    if (!this.isOpen) return;
    this.index = -1;
    this.#setTarget(null);
    window.removeEventListener('scroll', this.onReflow, { capture: true });
    window.removeEventListener('resize', this.onReflow);
    window.removeEventListener('keydown', this.onKeyDown);
    this.observer?.disconnect();
    if (this.frameId) cancelAnimationFrame(this.frameId);
    this.frameId = 0;
    this.element.remove();
    // Back where the reader was, not lost at the top of the document.
    this.anchor?.focus?.();
  }

  next() {
    this.#keepPromise();
    if (this.index >= this.steps.length - 1) this.close();
    else this.#goTo(this.index + 1);
  }

  back() {
    if (this.index > 0) this.#goTo(this.index - 1);
  }

  /**
   * Forward to the first card of the next chapter, or to the last card if this is
   * already the final chapter -- never off the end, which would close the tour on a
   * button that does not say "close".
   */
  skipChapter() {
    this.#keepPromise();
    const chapter = this.steps[this.index]?.chapter;
    for (let i = this.index + 1; i < this.steps.length; i += 1) {
      if (this.steps[i].chapter !== chapter) {
        this.#goTo(i);
        return;
      }
    }
    this.#goTo(this.steps.length - 1);
  }

  /**
   * Start the transport, if the card being left is the one that offered to.
   *
   * On the way OUT of the card, never on the way in, because of what that card says:
   * "Press Play, or hit Next and I will." Starting on arrival made a liar of it twice
   * over. The sound began before the reader had read the sentence offering them the
   * choice; and if they then pressed Play to stop it and moved on, the promise had
   * already been spent, so nothing restarted it -- and from the next card onwards the
   * Play button is behind the dim, which left the rest of the tour silent with no way
   * back. Firing here means Next always honours the offer, however the reader has left
   * the transport, and scheduler.start() is idempotent so pressing Play first and then
   * Next is not a double start.
   */
  #keepPromise() {
    const step = this.steps[this.index];
    if (!step?.play || this.promised.has(step.id)) return;
    this.promised.add(step.id);
    // Fire and forget: audio initialisation is async and the card must not wait on a
    // device that may refuse. A failure already shows in the header's status line.
    Promise.resolve(this.start?.()).catch(() => {});
  }

  #onKeyDown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.close();
      return;
    }
    // The page's own space-bar shortcut only fires when the body has focus, which it
    // never does while a card is up -- so the tour has to carry it, or the second card
    // is promising a key that does nothing for the next twenty-two. It is also the
    // only way back to the transport once the Play button is behind the dim. Not while
    // a button has focus, where space means "press this button" and taking that away
    // would break the card's own controls.
    // tagName rather than `instanceof HTMLButtonElement`: `doc` can be a document this
    // widget was handed rather than the one this module was loaded into, and each
    // window has its own constructors, so instanceof would answer false for a perfectly
    // ordinary button from the other realm.
    if (event.code === 'Space' && this.doc.activeElement?.tagName !== 'BUTTON') {
      event.preventDefault();
      this.toggleTransport?.();
      return;
    }
    // Only while focus is inside the card. A drag-number in the hole uses the arrows
    // to nudge its value, and the tour must not steal that from it.
    if (!this.cardEl.contains(this.doc.activeElement)) return;
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      this.next();
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      this.back();
    }
  }

  // -------------------------------------------------------------------------
  // One card
  // -------------------------------------------------------------------------

  #goTo(index) {
    const step = this.steps[index];
    if (!step) return;
    this.index = index;
    this.corrected = false;

    // Once per opening, never again on a revisit. Going Back to re-read a card, or
    // using Skip chapter and stepping back into it, must not re-stamp the value the
    // reader has since dialled in themselves -- that is the same broken promise as a
    // later card overwriting an earlier one, just reached by a different route.
    if (!this.applied.has(step.id)) {
      this.applied.add(step.id);
      this.#apply(step);
    }
    this.#renderCard(step, index);
    this.#setTarget(this.#resolve(step));

    // `center` clears both pieces of fixed chrome -- the sticky header above and the
    // info bar below -- without either being measured. The smooth scroll needs no
    // completion callback: the hole is recomputed on every scroll event, so it rides
    // the animation rather than waiting for it.
    this.target?.scrollIntoView({
      block: 'center',
      inline: 'nearest',
      behavior: this.#reducedMotion() ? 'auto' : 'smooth',
    });
    // Measured immediately so the hole never flashes at the previous card's position,
    // then again next frame once the card's own new copy has been laid out and its
    // height -- which decides where it can sit -- is real.
    this.#layout();
    this.#scheduleLayout();
  }

  /** Matches the stylesheet's own query, so the two cannot disagree. */
  #reducedMotion() {
    return Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  }

  /**
   * What the card does to the instrument.
   *
   * The page swaps first, so anything written afterwards lands on controls that are
   * already on screen. `step.play` is deliberately absent: starting the transport is
   * the one side effect that happens on the way out of a card rather than into it --
   * see #keepPromise.
   */
  #apply(step) {
    if (typeof step.show === 'number') this.selectTrack?.(step.show);
    const trackId = step.track ?? 0;
    for (const [key, value] of Object.entries(step.set ?? {})) {
      this.setParam(key, value, trackId);
    }
  }

  #renderCard(step, index) {
    this.chapterEl.textContent = step.chapter;
    this.countEl.textContent = `${index + 1} of ${this.steps.length}`;
    this.titleEl.textContent = step.title;
    this.bodyEl.textContent = step.body;

    const last = index === this.steps.length - 1;
    this.nextEl.textContent = last ? 'Done' : 'Next ›';
    this.backEl.disabled = index === 0;
    // Nothing left to skip to on the final chapter, and a button that would only move
    // one card is worse than no button.
    this.skipEl.hidden = !this.steps.slice(index + 1).some((s) => s.chapter !== step.chapter);
  }

  /**
   * The element a step points at.
   *
   * `target` is a `data-info` id -- the attribute every control on the page already
   * carries, naming its own parameter key. `~=` rather than `=` because the attribute
   * may list several ids: the bias/spread track is one element driving two parameters.
   * `selector` is the escape hatch for regions that are not one control.
   */
  #resolve(step) {
    if (step.target) return this.doc.querySelector(`[data-info~="${step.target}"]`);
    if (step.selector) return this.doc.querySelector(step.selector);
    return null;
  }

  #setTarget(element) {
    if (this.target && this.observer) this.observer.unobserve(this.target);
    this.target = element ?? null;
    if (this.target && this.observer) this.observer.observe(this.target);
    // A step with nothing to point at (the opening and closing cards) reads as a
    // plain dialog rather than as a spotlight aimed at nothing.
    this.element.classList.toggle('tutorial--no-target', !this.target);
  }

  #scheduleLayout() {
    if (this.frameId || !this.isOpen) return;
    this.frameId = requestAnimationFrame(() => {
      this.frameId = 0;
      if (this.isOpen) this.#layout();
    });
  }

  // -------------------------------------------------------------------------
  // Geometry
  // -------------------------------------------------------------------------

  /**
   * Place the four dim panels, the ring and the card.
   *
   * Everything here is in viewport coordinates, because every one of those elements is
   * `position: fixed` -- which is also why this has to run again on scroll.
   */
  #layout() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const hole = this.#holeRect(vw, vh);
    const card = { w: this.cardEl.offsetWidth, h: this.cardEl.offsetHeight };
    const spot = hole && this.#placeCardAround(hole, card, vw, vh);

    // The card had to dock, and docking left a sliver rather than a hole. That only
    // happens because scrollIntoView centred the target, which on a short screen
    // guarantees neither half has room for the card. One nudge moves the target into
    // the half the card is not using, and the guard makes it once per card so this
    // cannot oscillate.
    if (spot?.docked && spot.hole.height < MIN_HOLE_PX && !this.corrected) {
      this.corrected = true;
      if (this.#scrollClear(hole, card, vh, spot.docked)) {
        this.#layout();
        return;
      }
    }

    if (!spot || spot.hole.height < 1) {
      // Nothing to draw a hole around -- either the step names nothing, or the target
      // is off screen, or the screen is too small to hold the card and the control at
      // once. The top panel covers the viewport on its own and the other three
      // collapse, so the page is uniformly dimmed.
      this.#place(this.masks[0], 0, 0, vw, vh);
      for (const el of this.masks.slice(1)) this.#place(el, 0, 0, 0, 0);
      this.ringEl.style.opacity = '0';
      // The card is only centred when the step genuinely points at nothing. A target
      // that is merely off screen is one the smooth scroll is still travelling
      // towards, and sliding the card to the middle and back out again as it arrives
      // reads as a flicker -- so in that case the card simply stays where it was.
      if (!this.target) this.#placeCard((vw - card.w) / 2, (vh - card.h) / 2);
      return;
    }

    this.#place(this.masks[0], 0, 0, vw, spot.hole.top);
    this.#place(this.masks[1], spot.hole.right, spot.hole.top, vw - spot.hole.right, spot.hole.height);
    this.#place(this.masks[2], 0, spot.hole.bottom, vw, vh - spot.hole.bottom);
    this.#place(this.masks[3], 0, spot.hole.top, spot.hole.left, spot.hole.height);

    this.ringEl.style.opacity = '1';
    this.#place(this.ringEl, spot.hole.left, spot.hole.top, spot.hole.width, spot.hole.height);
    this.#placeCard(spot.left, spot.top);
  }

  /**
   * Scroll the target out from under where the card has to dock.
   *
   * Returns whether the page actually moved. It often cannot -- the target may be
   * `position: fixed` (the info bar), or the document may already be at an end -- and
   * a false answer is what stops #layout retrying against a page that will not budge.
   *
   * Deliberately instant, even when smooth scrolling is on elsewhere: this is a
   * correction to a scroll already in progress, and animating it would race the one it
   * is correcting.
   */
  #scrollClear(hole, card, vh, edge) {
    const before = window.scrollY;
    const delta = edge === 'bottom'
      // Card at the foot: the target has to end above it, so the page moves down.
      ? hole.bottom - (vh - card.h - GAP * 2)
      // Card at the head: the target has to start below it, so the page moves up.
      : hole.top - (GAP * 2 + card.h);
    window.scrollBy(0, delta);
    return window.scrollY !== before;
  }

  /** The target's box, padded, then clipped to the viewport. Null if there is none. */
  #holeRect(vw, vh) {
    if (!this.target) return null;
    const r = this.target.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    const left = Math.max(0, r.left - PAD);
    const top = Math.max(0, r.top - PAD);
    const right = Math.min(vw, r.right + PAD);
    const bottom = Math.min(vh, r.bottom + PAD);
    // Scrolled entirely out of sight, which a smooth scroll makes momentarily true.
    if (right <= left || bottom <= top) return null;
    return {
      left, top, right, bottom, width: right - left, height: bottom - top,
    };
  }

  /**
   * Where the card goes, and what the hole ends up being.
   *
   * First side with room wins: right, then left -- both of which leave the target's
   * full height uncovered -- then below, then above. Beside is skipped entirely on a
   * narrow screen, where nothing fits next to anything.
   *
   * Only when none of the four has room -- a target taller than the space the card
   * needs, which is what a full instrument panel is -- does the card dock to the
   * bottom edge and the hole get *trimmed* up to clear it. Trimming shows less of a
   * long target rather than hiding the card, which is the right way round: the card
   * can always be read, and the ring still says where to look.
   *
   * The one thing this must never do is let the card cover the target. Every branch
   * below therefore either leaves the hole untouched and puts the card clear of it, or
   * docks the card to an edge and *trims the hole back to the card*. Nothing ever
   * extends a hole to meet a floor -- an earlier version did, and on a phone it pushed
   * the info bar's 30px hole down through the docked card to reach an 80px minimum.
   * A hole too short to be worth showing is the corrective scroll's problem, not this
   * method's; here it simply comes back short.
   */
  #placeCardAround(hole, card, vw, vh) {
    const clampX = (x) => Math.min(vw - card.w - GAP, Math.max(GAP, x));
    const clampY = (y) => Math.min(vh - card.h - GAP, Math.max(GAP, y));
    const midY = clampY(hole.top + hole.height / 2 - card.h / 2);
    const midX = clampX(hole.left + hole.width / 2 - card.w / 2);
    const fitsBeside = (space) => space >= card.w + GAP * 2;
    const fitsStacked = (space) => space >= card.h + GAP * 2;

    // Beside is best: it leaves the target's whole height uncovered. Skipped outright
    // on a narrow screen, where nothing fits next to anything.
    if (vw > NARROW_PX) {
      if (fitsBeside(vw - hole.right)) return { hole, left: hole.right + GAP, top: midY };
      if (fitsBeside(hole.left)) return { hole, left: hole.left - card.w - GAP, top: midY };
    }
    if (fitsStacked(vh - hole.bottom)) return { hole, left: midX, top: hole.bottom + GAP };
    if (fitsStacked(hole.top)) return { hole, left: midX, top: hole.top - card.h - GAP };

    // Nothing clears it, so the card docks and the hole gives way. Both edges are
    // costed and the one that leaves more of the target showing wins -- for a tall
    // panel that is usually the bottom, for a target already low on the screen the top.
    const bottomDock = vh - card.h - GAP;
    const trimmedBottom = Math.min(hole.bottom, bottomDock - GAP);
    const trimmedTop = Math.max(hole.top, GAP + card.h + GAP);
    const above = { edge: 'bottom', top: bottomDock, height: trimmedBottom - hole.top };
    const below = { edge: 'top', top: GAP, height: hole.bottom - trimmedTop };
    const best = above.height >= below.height ? above : below;

    return {
      hole: best.edge === 'bottom'
        ? { ...hole, bottom: trimmedBottom, height: above.height }
        : { ...hole, top: trimmedTop, height: below.height },
      left: midX,
      top: best.top,
      docked: best.edge,
    };
  }

  #placeCard(left, top) {
    this.cardEl.style.left = `${Math.round(left)}px`;
    this.cardEl.style.top = `${Math.round(top)}px`;
  }

  /** Non-negative width/height, so a rounding artefact cannot flip a panel inside out. */
  #place(el, left, top, width, height) {
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
    el.style.width = `${Math.max(0, Math.round(width))}px`;
    el.style.height = `${Math.max(0, Math.round(height))}px`;
  }
}
