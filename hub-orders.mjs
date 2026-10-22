// Runs the orders placed on the hub's website. The Mac is the only place an order can be carried out (it holds the
// developer's Claude), so this listens to the hub's event stream, runs each order through `execute` (the same functions
// the panel's own buttons use), one at a time, and reports the outcome back to the hub.
//
// Orders arrive two ways: as events on the stream, and as the hub's list of pending ones, which is asked for at the start
// and again whenever an order event arrives, since the stream reconnects out of sight and may have missed some. An id is
// run once per session however often it is seen.

const RETRY = 30_000;

/** Only strings go back to the hub as `error` and `caption`. */
function report(result) {
  const r = { ok: result?.ok === true };
  if (typeof result?.error === 'string') r.error = result.error;
  if (typeof result?.caption === 'string') r.caption = result.caption;
  return r;
}

export function createHubOrders({ hub, execute, onDone, timers = { setTimeout, clearTimeout }, log = console.error }) {
  let controller = null;     // exists while started
  let listening = false;     // the stream promise is pending
  let current = null;        // the order being run
  let chain = Promise.resolve();   // everything that touches orders waits its turn here
  let retry = null;
  const seen = new Set();    // ids started this session

  const enqueue = (fn) => {
    if (!controller) return chain;
    const { signal } = controller;
    chain = chain.then(() => (signal.aborted ? undefined : fn())).catch((e) => log('hub orders failed:', e?.message ?? String(e)));
    return chain;
  };

  async function run(order) {
    if (typeof order?.id !== 'string' || seen.has(order.id)) return;
    seen.add(order.id);
    current = order;
    let result;
    try {
      result = report(await execute(order));
    } catch (e) {
      result = { ok: false, error: `The Mac could not run it: ${e?.message ?? String(e)}` };
    }
    const sent = await hub.request('POST', `/api/me/orders/${encodeURIComponent(order.id)}/done`, { body: result });
    if (!sent.ok) log(`hub orders: could not report order ${order.id} (${sent.status}).`);
    try { await onDone?.(order, result); } catch (e) { log('hub orders: onDone failed:', e?.message ?? String(e)); }
    current = null;
  }

  /** Run what the hub still has pending; if it cannot be asked, ask again in half a minute. */
  async function drain() {
    const r = await hub.request('GET', '/api/me/orders?status=pending');
    if (r.status === 0 || r.status >= 500) {
      if (controller && retry === null) {
        retry = timers.setTimeout(() => { retry = null; if (controller) enqueue(drain); }, RETRY);
      }
      return;
    }
    for (const order of Array.isArray(r.body?.orders) ? r.body.orders : []) {
      if (!controller) return;
      await run(order);
    }
  }

  function start() {
    if (controller) return;
    controller = new AbortController();
    const { signal } = controller;
    enqueue(drain);
    listening = true;
    hub.stream('/api/me/events', (event, data) => {
      if (event !== 'order') return;
      enqueue(() => run(data));
      enqueue(drain);
    }, { signal })
      .catch((e) => log('hub orders: the stream failed:', e?.message ?? String(e)))
      .finally(() => { if (controller?.signal === signal) listening = false; });
  }

  function stop() {
    if (!controller) return;
    controller.abort();
    controller = null;
    listening = false;
    if (retry !== null) timers.clearTimeout(retry);
    retry = null;
  }

  const state = () => ({ running: controller !== null, listening, current });

  return { start, stop, state };
}
