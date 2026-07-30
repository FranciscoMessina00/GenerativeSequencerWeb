/**
 * Minimal synchronous pub/sub.
 *
 * The whole point is to keep the sequencer from ever holding a reference to the
 * audio engine or the UI. A step is published; whoever cares subscribes.
 */
export class EventBus {
  constructor() {
    this.listeners = new Map();
  }

  /** Subscribe to `event`. Returns an unsubscribe function. */
  on(event, handler) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event).add(handler);
    return () => this.off(event, handler);
  }

  off(event, handler) {
    this.listeners.get(event)?.delete(handler);
  }

  /**
   * Publish synchronously. A throwing subscriber is logged and skipped rather
   * than allowed to abort the remaining subscribers -- a broken UI listener
   * must never be able to stall the audio scheduler.
   */
  emit(event, payload) {
    const handlers = this.listeners.get(event);
    if (!handlers) return;
    for (const handler of [...handlers]) {
      try {
        handler(payload);
      } catch (err) {
        console.error(`EventBus: listener for "${event}" threw`, err);
      }
    }
  }
}
