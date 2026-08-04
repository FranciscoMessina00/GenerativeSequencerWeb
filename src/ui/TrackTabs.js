import { DragNumber } from './DragNumber.js';
import { PAGE_PALETTES } from './palette.js';
import { promote, stepProgress } from './playheadProgress.js';
import { svgEl } from './icons.js';
import { formatNumber } from './numberUtils.js';

/**
 * The four track pages, as a tab strip: which one's controls are on screen, how loud
 * each one is, whether it is audible, and where its playhead has got to.
 *
 * Three things share one row because they answer the same question -- "what is track
 * 3 doing right now" -- and only one page of controls is ever visible. A muted track
 * with no bar and no fader would be invisible in every sense.
 *
 * The bar is the point. Selecting a page swaps the ring, so the three tracks you
 * cannot see would otherwise give no sign of running at all; each tab carries a
 * groove that fills across one revolution of *that* track's pattern. It is hidden on
 * the selected tab, where the ring says the same thing far better.
 *
 * Each tab carries its own page's `--accent` inline, so all four read as their own
 * colour at once even though only one of them is the document's accent. That works
 * because a custom property referencing `var(--accent)` is resolved where it is
 * *declared*: the tokens in :root are computed against the document's accent and
 * inherit as finished colours, so overriding `--accent` on a tab reaches that tab's
 * own rules and nothing else.
 */

/** How wide the tab strip lets a track's name grow before it is just an index. */
const NAME_MAX = 4;

/**
 * Audible / silent, as a filled or hollow dot.
 *
 * A dot rather than a speaker glyph: at this size the waves coming off a speaker
 * turn to mush, while filled-versus-hollow survives being 9px across. Local to this
 * widget for the same reason LfoPanel keeps its own -- it means nothing elsewhere.
 *
 * Muted is the hollow one, which needs no class at all: .icon's own rule already
 * strokes a circle and leaves it unfilled, and .icon__dot is what opts into a fill.
 */
function buildMuteIcon(muted) {
  const svg = svgEl('svg', { viewBox: '0 0 24 24', class: 'icon' });
  svg.append(svgEl('circle', muted
    ? { cx: 12, cy: 12, r: 6 }
    : { cx: 12, cy: 12, r: 7, class: 'icon__dot' }));
  return svg;
}

export class TrackTabs {
  /**
   * @param {object} opts
   * @param {import('../core/EventBus.js').EventBus} opts.bus
   * @param {number} opts.trackCount
   * @param {object} opts.muteSpec  paramSchema entry for `mute`
   * @param {object} opts.levelSpec paramSchema entry for `level`
   * @param {() => number} opts.getAudioTime the audio clock, for the bars
   * @param {(trackId: number) => void} opts.onSelect asked to switch page; the page
   *   swap itself belongs to the bootstrap, not here
   * @param {number} [opts.active]
   */
  constructor({ bus, trackCount, muteSpec, levelSpec, getAudioTime, onSelect, active = 0 }) {
    this.bus = bus;
    this.muteSpec = muteSpec;
    this.levelSpec = levelSpec;
    this.getAudioTime = getAudioTime;
    this.onSelect = onSelect;
    this.active = active;
    this.running = false;

    this.element = document.createElement('nav');
    this.element.className = 'tabs';
    this.element.setAttribute('role', 'tablist');
    this.element.setAttribute('aria-label', 'Track pages');

    /** Per track: its DOM, its widgets, and the steps not yet audible. */
    this.lanes = Array.from({ length: trackCount }, (_, i) => this.#buildLane(i));
    this.element.append(...this.lanes.map((lane) => lane.element));

    this.#renderActive();
    // One loop for every bar, not one per tab. It re-arms unconditionally, matching
    // EuclidView's: the cost of a frame that finds nothing to do is a clock read.
    requestAnimationFrame(() => this.frame());
  }

  #buildLane(trackId) {
    const page = PAGE_PALETTES[trackId % PAGE_PALETTES.length];
    const name = page.name.length <= NAME_MAX ? page.name : String(trackId + 1);

    const element = document.createElement('div');
    element.className = 'tab';
    element.setAttribute('role', 'tab');
    element.dataset.info = 'trackTab';
    // Its own page's colour, whichever page the document is currently wearing.
    element.style.setProperty('--accent', page.accent);

    const muteButton = document.createElement('button');
    muteButton.type = 'button';
    muteButton.className = 'tab__mute';
    muteButton.dataset.info = this.muteSpec.key;
    muteButton.addEventListener('click', (e) => {
      // Muting is not selecting: hitting the dot on a tab you are not on should not
      // drag the whole control surface over with it.
      e.stopPropagation();
      this.#emit(trackId, this.muteSpec.key, !this.lanes[trackId].muted);
    });

    const nameEl = document.createElement('span');
    nameEl.className = 'tab__name';
    nameEl.textContent = name;

    const level = new DragNumber({
      spec: this.levelSpec,
      format: (v) => `${Math.round(v * 100)}`,
      describe: (v) => `${formatNumber(v * 100, 1)} percent`,
      onInput: (v) => this.#emit(trackId, this.levelSpec.key, v),
    });
    level.element.classList.add('dragnum--compact');
    // Dragging the fader is not selecting either, for the same reason as the dot --
    // and the drag captures the pointer, so the click would land here on release.
    level.element.addEventListener('pointerdown', (e) => e.stopPropagation());

    const head = document.createElement('div');
    head.className = 'tab__head';
    head.append(muteButton, nameEl, level.element);

    const fill = document.createElement('i');
    fill.className = 'tab__fill';
    const bar = document.createElement('div');
    bar.className = 'tab__bar';
    bar.append(fill);

    element.append(head, bar);
    element.addEventListener('click', () => this.onSelect?.(trackId));
    element.addEventListener('keydown', (e) => this.#onKeyDown(e, trackId));

    const lane = {
      trackId, name, element, muteButton, nameEl, level, bar, fill,
      /** Steps decided but not yet audible -- see playheadProgress.promote. */
      queue: [],
      current: null,
      muted: Boolean(this.muteSpec.def),
      /** Last painted fraction, so an unchanged frame writes no style at all. */
      painted: -1,
    };
    this.#renderMute(lane);
    return lane;
  }

  /**
   * Arrow keys move between tabs, Home/End jump to the ends -- the tabs pattern
   * everyone's muscle memory already has. Space and Enter are handled by the click
   * listener, since a focused tab fires click on both.
   */
  #onKeyDown(event, trackId) {
    const last = this.lanes.length - 1;
    let next = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = trackId === last ? 0 : trackId + 1;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = trackId === 0 ? last : trackId - 1;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = last;
    if (next === null) return;
    event.preventDefault();
    this.onSelect?.(next);
    this.lanes[next].element.focus();
  }

  #emit(trackId, key, value) {
    this.bus.emit('param:change', { trackId, key, value });
  }

  /** The two schema keys this strip owns. */
  keys() {
    return [this.muteSpec.key, this.levelSpec.key];
  }

  /**
   * Reflect a committed value without emitting.
   *
   * Takes a trackId, unlike every other widget's setValue: the rest of the control
   * surface shows one track and is filtered to it, but all four tabs are on screen
   * at once, so this has to hear about every track.
   */
  setValue(key, value, trackId = 0) {
    const lane = this.lanes[trackId];
    if (!lane) return;
    if (key === this.muteSpec.key) {
      lane.muted = Boolean(value);
      this.#renderMute(lane);
    } else if (key === this.levelSpec.key) {
      lane.level.setValue(value);
    }
  }

  #renderMute(lane) {
    lane.muteButton.replaceChildren(buildMuteIcon(lane.muted));
    lane.muteButton.classList.toggle('is-muted', lane.muted);
    lane.muteButton.setAttribute('aria-pressed', String(lane.muted));
    lane.muteButton.setAttribute('aria-label', `${this.muteSpec.label} track ${lane.name}`);
    lane.element.classList.toggle('is-muted', lane.muted);
  }

  /** Which page's controls are on screen. Does not switch it -- see onSelect. */
  setActive(trackId) {
    if (!this.lanes[trackId]) return;
    this.active = trackId;
    this.#renderActive();
  }

  #renderActive() {
    for (const lane of this.lanes) {
      const isActive = lane.trackId === this.active;
      lane.element.classList.toggle('is-active', isActive);
      lane.element.setAttribute('aria-selected', String(isActive));
      // Roving tabindex: one stop for the whole strip, then arrows within it.
      lane.element.tabIndex = isActive ? 0 : -1;
    }
  }

  /**
   * Called when the scheduler decides a step, well before it sounds -- the bars gate
   * it on the audio clock themselves, exactly as the ring does.
   *
   * The pattern length comes from the caller because the `step` event does not carry
   * it, and the bar spans one revolution rather than one step.
   */
  enqueue(step, patternLength) {
    const lane = this.lanes[step.trackId];
    if (!lane) return;
    lane.queue.push({
      stepIndex: step.stepIndex,
      audioTime: step.audioTime,
      stepDuration: step.stepDuration,
      patternLength,
    });
  }

  setRunning(running) {
    this.running = Boolean(running);
    if (this.running) return;
    // Stopped: empty the grooves rather than leaving four bars frozen part-way,
    // which reads as still playing.
    for (const lane of this.lanes) {
      lane.queue.length = 0;
      lane.current = null;
      this.#paint(lane, 0);
    }
  }

  /**
   * One tick of every bar. Public for the same reason EuclidView.frame() is: a check
   * page can then drive it against a fake clock instead of racing the real
   * requestAnimationFrame chain this also re-arms.
   */
  frame() {
    const now = this.getAudioTime();
    for (const lane of this.lanes) {
      const next = promote(lane.queue, now);
      if (next) lane.current = next;
      // The selected tab's groove is hidden -- the ring is saying this already, and
      // far better -- so there is nothing to compute for it.
      if (this.running && lane.trackId !== this.active) {
        this.#paint(lane, stepProgress(lane.current, now));
      }
    }
    requestAnimationFrame(() => this.frame());
  }

  /**
   * scaleX rather than width: it is a compositor-only change, so four bars moving
   * every frame cost no layout. Rounded to a whole percent first -- the groove is
   * ~70px wide, so finer than that is a style write nobody can see.
   */
  #paint(lane, fraction) {
    const quantized = Math.round(fraction * 100) / 100;
    if (quantized === lane.painted) return;
    lane.painted = quantized;
    lane.fill.style.transform = `scaleX(${quantized})`;
  }
}
