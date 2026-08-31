/**
 * The guided tour, as data -- what each card says, what it points at, and what it
 * dials into the running instrument so the reader hears the thing being described.
 *
 * Pure data, no imports, for the same two reasons infoText.js is: this file exists to
 * be rewritten freely without reading any other, and staying import-free lets a Node
 * test check every card against the schema with no DOM in sight. TutorialOverlay.js is
 * what walks this list; it knows nothing about any particular step.
 *
 * ---- The shape of a step ----
 *
 *   id        stable, unique, kebab-case. Never displayed; it is what a test names and
 *             what a bug report can point at.
 *   chapter   the heading on the card. Cards sharing a chapter must be CONTIGUOUS --
 *             "Skip chapter" walks forward to the first card with a different one, so
 *             a chapter appearing twice would strand the reader in the second half.
 *   title     the card's own line.
 *   body      the copy. Written for someone who has never used a sequencer: no term is
 *             used before the card that introduces it, and nothing is described as
 *             "simply" anything.
 *
 * ...and exactly one way of pointing, never both:
 *
 *   target    a `data-info` id, resolved as `[data-info~="<id>"]`. Every control on
 *             the page already carries one naming its own parameter key -- see
 *             ui/DragNumber.js and ui/UIController.js, which set it from `spec.key`
 *             in their constructors, and main.js's assign mode, which already treats
 *             the attribute as the map of what is addressable. So a step can point at
 *             any control on the instrument without a single line of new markup, and
 *             a test holds it to ids the info footer also describes.
 *   selector  a plain CSS selector, for the handful of *regions* that are not one
 *             control and so carry no `data-info`: the tab strip, the trigger row, an
 *             instrument panel, the footer.
 *
 * ...plus what the card actually does, all of it optional:
 *
 *   set       parameters to write, as `{ key: value }`. They go out as ordinary
 *             `param:change` requests, so the store commits them, the engines hear
 *             them and the on-screen controls move by themselves -- exactly as if the
 *             reader had dialled them in. A test checks every key against the schema
 *             and every value against its own range, so a card cannot quietly
 *             demonstrate a number the store would clamp to something else.
 *
 *             **A card writes only the parameter it is introducing.** No card
 *             re-states a value an earlier card already demonstrated, and no card
 *             opens a chapter by dialling the previous one back to a baseline. That
 *             rule is what lets the reader stop and play: drag Steps to 5 on the card
 *             that introduces it and it is still 5 four cards later. It costs the copy
 *             something -- a card cannot say "seven into sixteen" when it does not
 *             know what Steps is any more -- and the copy gives way, because a tour
 *             that quietly undoes the reader's own edit teaches them not to make one.
 *   track     which track `set` addresses. Default 0.
 *   show      which track's page to bring on screen. Deliberately separate from
 *             `track`: the card that unmutes the drums writes to track 1 while
 *             staying on track 0's page, because what it is pointing at is the tab
 *             strip, where all four tracks are visible at once.
 *   play      start the transport. On exactly one card, the second.
 *
 * ---- What this tour does to the reader's settings ----
 *
 * It keeps them. There is no snapshot and no restore: the tour is a demonstration you
 * end up holding, and the opening card says so and names Patch -> Load as the way back
 * to a finished setting. Anything else would mean the reader watches a sound being
 * built and then has it taken away at the last card.
 *
 * The one thing opening the tour *does* reset is which channels are audible: main.js
 * mutes all but the first and switches to its page, so the tour starts from the same
 * one-voice arrangement its copy is written against. That is staging, not settings --
 * every number the reader has dialled in survives it, and the Channels chapter is
 * what turns the others back on.
 */

export const TUTORIAL_STEPS = [
  // ---- Start ---------------------------------------------------------------
  // No target: nothing is worth pointing at before the reader knows what they are
  // looking at. This is also the card that has to earn the next thirty seconds.
  {
    id: 'welcome',
    chapter: 'Start',
    title: 'A machine that writes music',
    body: 'You will not be placing notes here. You set a few rules and the instrument invents a part that follows them. This tour changes real settings as it goes so you can hear each one, and it leaves them changed. Patch → Load drops you back into a finished sound whenever you want one.',
  },

  // ---- Rhythm --------------------------------------------------------------
  // The pattern before the pitch. The ring is the one thing on screen with no
  // equivalent in any other kind of software, so it is what the tour opens on.
  {
    id: 'play',
    chapter: 'Rhythm',
    title: 'Start the sound',
    body: 'Press Play, or hit Next and I will. Everything from here happens while it is running, so each change is audible the moment it lands. The space bar starts and stops it too, at any point in this tour, which is worth remembering once this button is behind the dim.',
    target: 'play',
    // Honoured when the reader leaves this card, not when they arrive on it, so the
    // sentence above is an offer rather than a description of something that already
    // happened. TutorialOverlay's #keepPromise is where that is done and why.
    play: true,
    // Deliberately writes nothing. An earlier version dialled a textbook pattern in
    // here -- sixteen steps, five hits, no chance, no loop -- which read as a sensible
    // baseline right up until someone re-opened the tour and watched it flatten the
    // rhythm they had spent ten minutes on. Whatever is in the track is what the tour
    // talks over. Muting is handled once, when the tour opens; see main.js.
  },
  {
    id: 'ring',
    chapter: 'Rhythm',
    title: 'The circle is the sequence',
    body: 'One lap of the ring is one cycle of the pattern. Each wedge is a step, the bright ones are the steps that fire a note, and the marker sweeping round is where the music has got to.',
    target: 'ring',
  },
  {
    id: 'steps',
    chapter: 'Rhythm',
    title: 'How many slots',
    body: 'Steps cuts the lap into slots, and I have set it to 8. Fewer slots, so the cycle comes round sooner. Drag the number up and down to change it yourself; every number on this page works that way, and whatever you leave it on is what the rest of the tour runs on.',
    target: 'steps',
    set: { steps: 8 },
  },
  {
    id: 'pulses',
    chapter: 'Rhythm',
    title: 'How many of them fire',
    // Names no ratio, because it cannot know one: Steps is whatever the reader left on
    // the previous card. The even spreading is the point, not the arithmetic.
    body: 'Triggers is how many of those slots actually play, and the instrument spreads them as evenly as it possibly can across however many there are. That even spreading is the idea the whole machine is built on, and it is how a great deal of the world\'s drum music is put together.',
    target: 'pulses',
    set: { pulses: 5 },
  },
  {
    id: 'rotation',
    chapter: 'Rhythm',
    title: 'Turn the pattern',
    body: 'Rotation slides the hits round the circle. Nothing is added and nothing is removed; the same pattern starts somewhere else, which moves where the emphasis lands.',
    target: 'rotation',
    set: { rotation: 2 },
  },
  {
    id: 'division',
    chapter: 'Rhythm',
    title: 'How fast a step is',
    body: 'Division is how long one slot lasts, written as a note value, so a bigger number means a shorter step. T and D beside it bend the step into a triplet or a dotted note, the quickest way to stop a pattern sounding square.',
    selector: '.step-division',
    set: { stepDivision: 8 },
  },
  {
    id: 'chance',
    chapter: 'Rhythm',
    title: 'Letting chance in',
    body: 'The dice flips a coin on every step, and the symbol to its left decides what to do with the result: OR adds those hits to the pattern, AND keeps only where both agree, XOR keeps whichever fires alone. This is where a fixed loop starts surprising you.',
    selector: '.trig-row',
    set: { probability: 0.5, logicOp: 3 },
  },
  {
    id: 'trig-loop',
    chapter: 'Rhythm',
    title: 'Catching a happy accident',
    body: 'Loop freezes the last few coin flips and repeats them instead of rolling new ones, so a lucky bar becomes a riff you can keep. The number sets how many steps it holds, and the dial beside it shuffles them into a different order.',
    target: 'trigLoop',
    set: { trigLoop: true, trigLoopLength: 8 },
  },

  // ---- Pitch & Velocity ----------------------------------------------------
  // Still track 0. Now that there is a rhythm, which note and how hard.
  {
    id: 'notes',
    chapter: 'Pitch & Velocity',
    title: 'Which notes come out',
    body: 'One control, two directions. Drag across to move the centre the notes gather around; drag up and down to set how far they may wander from it. Narrow is nearly one note, wide is a wild melody.',
    target: 'noteBias',
    set: { noteBias: 55, noteSpread: 9 },
  },
  {
    id: 'scale',
    chapter: 'Pitch & Velocity',
    title: 'Keeping it in tune',
    body: 'Every note is pulled onto the nearest degree of this scale, rooted on the centre you just set. It is the whole difference between a random walk and something that sounds like a tune. Try a few; the character changes more than you would expect.',
    target: 'scale',
    set: { scale: 5 },
  },
  {
    id: 'glide',
    chapter: 'Pitch & Velocity',
    title: 'Sliding between notes',
    body: 'Glide is how much of each step a note spends sliding from the pitch before it instead of arriving instantly. The icon beside the number chooses whether that slide is straight or curved.',
    selector: '.glide-control',
    set: { glideAmount: 0.4 },
  },
  {
    id: 'note-loop',
    chapter: 'Pitch & Velocity',
    title: 'Freezing a melody',
    body: 'The same freeze-and-repeat trick, this time on pitch: capture the last few notes and play them round and round. Between this, the rhythm loop and the scale you can pin down a phrase you like without giving up the generator that found it.',
    target: 'noteLoop',
    set: { noteLoop: true, noteLoopLength: 4 },
  },
  {
    id: 'velocity',
    chapter: 'Pitch & Velocity',
    title: 'How hard it is played',
    body: 'Velocity is how hard each note is struck: across for the average, up and down for how much it varies note to note. A little variation is what stops a machine part sounding typed in. The row underneath freezes it exactly as the notes were frozen.',
    target: 'velBias',
    set: { velBias: 0.7, velSpread: 0.45 },
  },

  // ---- Sound ---------------------------------------------------------------
  // One note, up close: the voice, its shape in time, its physical properties, and
  // the one thing on the page that moves a control without being touched.
  {
    id: 'instrument',
    chapter: 'Sound',
    title: 'The voice on this page',
    body: 'This picks what the channel sounds like. Right now it is a modal string, a physical model of a plucked string rather than a recording of one. Everything in the panel below belongs to whichever voice is chosen here.',
    target: 'instrument',
  },
  {
    id: 'envelope',
    chapter: 'Sound',
    title: 'The shape of one note',
    body: 'A single note drawn from start to finish: how quickly it rises, how long it stays up, how long it takes to fall away. I have stretched all three, so the plucked string has become a slow swell. The line along the top marks how much of it fits inside one step.',
    selector: '.envelope',
    set: {
      envAttack: 300, envHold: 400, envDecay: 1200, envCurve: true,
    },
  },
  {
    id: 'string',
    chapter: 'Sound',
    title: 'What makes it a string',
    body: 'These are properties of the string itself: how many overtones it is built from, how stiff it is, and where along its length it is plucked. I have moved the plucking point towards the bridge, which is why it just turned thinner and brighter.',
    selector: '.group[data-group="String"]',
    set: { modBias: 12, damping: 0.9, stiffness: 20 },
  },
  {
    id: 'lfo',
    chapter: 'Sound',
    title: 'A hand that moves a control for you',
    body: 'This is a slow wave that nudges one control up and down on its own, in time with the music. It is now pointed at Decay, so every note rings for a different length without you touching it. Press Map and then click any control that lights up, anywhere on the page, to send it somewhere else. The tour will wait.',
    selector: '.lfo',
    // MOD_TARGETS index 28, envDecay. Follows the envelope card deliberately: the
    // reader has just been shown the shape of one note, so a wave walking its decay
    // back and forth is a change they can already name. (It was noteBias, which
    // demonstrated the LFO by moving something two chapters behind it.)
    set: {
      lfoSync: true, lfoDivision: 1, lfoShape: 0, lfoFold: 0, lfoAmount: 0.35, lfoTarget: 28,
    },
  },

  // ---- Channels ------------------------------------------------------------
  // The issue's second half. Everything so far was one of four.
  {
    id: 'channels',
    chapter: 'Channels',
    title: 'Four channels, one clock',
    body: 'Everything so far has been one of four channels, all running off the same tempo. I have unmuted the second one, the drum underneath. The dot on each tab switches a channel on and off without stopping it.',
    selector: '.tabs',
    // Track 1, while the page stays on track 0: what this card points at is the strip,
    // where all four are visible at once, so the dot changing IS the demonstration.
    track: 1,
    // Unmuting only. The level is the *next* chapter card's demonstration, and setting
    // it here as well would mean that card silently overwrote a number this one had
    // already put on screen.
    set: { mute: false },
  },
  {
    id: 'switch-page',
    chapter: 'Channels',
    title: 'Opening another channel',
    body: 'Clicking a tab brings that channel on screen: the ring, the notes and the whole panel swap to it. This one plays a kick, and it has been keeping its own separate settings the entire time the string was showing.',
    selector: '.tab:nth-child(2)',
    show: 1,
  },
  {
    id: 'mix',
    chapter: 'Channels',
    title: 'Balancing them',
    body: 'The two numbers on every tab are its level in the mix and its swing, which is how far every other step is nudged late and what gives a pattern a shuffle instead of a march. The bar underneath shows how far through its own cycle that channel is.',
    selector: '.tab:nth-child(2) .tab__head',
    track: 1,
    set: { level: 0.65, swing: 0.2 },
  },
  {
    id: 'transport',
    chapter: 'Channels',
    title: 'Tempo and output',
    body: 'The only two settings that are not per-channel: the tempo every channel runs off, and the output level of the whole instrument. Reseed, beside them, rerolls the random numbers so the generators take a different path through the same rules.',
    selector: '.transport__nums',
    set: { bpm: 96 },
  },
  {
    id: 'infobar',
    chapter: 'Channels',
    title: 'Everything is labelled',
    body: 'Hover or touch any control on the page and this bar says in one line what it does. That is your reference from here on; nothing about this instrument is hidden behind a manual.',
    selector: '#infobar',
  },

  // ---- Finish --------------------------------------------------------------
  {
    id: 'finish',
    chapter: 'Finish',
    title: 'Go and break it',
    body: 'The fastest way in is to leave it playing and drag things while it runs; nothing here can be damaged. Patch → Load starts you from a finished sound instead, Reseed rerolls the randomness, and the Tutorial button brings this back whenever you want it.',
  },
];

/** Chapter names in the order they appear, each exactly once. */
export const TUTORIAL_CHAPTERS = [...new Set(TUTORIAL_STEPS.map((s) => s.chapter))];
