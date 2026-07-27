// Publish/subscribe event bus.
//
// Payloads are plain objects reused by the emitter where possible, so handlers
// must not retain a reference past the call. Handlers are invoked synchronously
// in subscription order; a throwing handler is logged and skipped so one bad
// subsystem cannot halt the frame.
//
// Canonical events:
//   weapon:fire      { origin, dir, seed, weapon }
//   weapon:reload    { phase: 'start'|'magout'|'magin'|'end' }
//   bullet:impact    { point, normal, surface, damage, fromPlayer }
//   damage:dealt     { target, amount, point, headshot, fromPlayer }
//   damage:taken     { amount, fromDir }
//   actor:death      { actor, point, fromPlayer }
//   player:land      { surface, impactSpeed }
//   player:footstep  { surface, running }
//   explosion        { point, radius, damage }
//   objective:advance{ stage }

export class EventBus {
  constructor() {
    this._handlers = new Map();
  }

  on(event, fn) {
    let list = this._handlers.get(event);
    if (!list) this._handlers.set(event, (list = []));
    list.push(fn);
    return () => this.off(event, fn);
  }

  off(event, fn) {
    const list = this._handlers.get(event);
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }

  emit(event, payload) {
    const list = this._handlers.get(event);
    if (!list) return;
    for (let i = 0; i < list.length; i++) {
      try {
        list[i](payload);
      } catch (err) {
        console.error(`[bus] handler for "${event}" threw:`, err);
      }
    }
  }

  clear() {
    this._handlers.clear();
  }
}
