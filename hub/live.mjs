// The live event stream per account: the Mac's service keeps GET /api/me/events open and learns of an order the moment it is
// placed. Kept in memory only (a stream belongs to a connection, and a restart simply makes the Mac reconnect); a comment
// ping every 20 seconds keeps proxies from closing an idle stream, and an account holds at most 5 streams.
export const MAX_STREAMS = 5;
export const PING_MS = 20_000;

export function createLive({ timers = { setInterval, clearInterval } } = {}) {
  /** accountId -> subscribers, oldest first. */
  const streams = new Map();

  function subscribe(accountId, res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 2000\n\n');

    const entry = { res, timer: null };
    const unsubscribe = () => {
      if (entry.timer === null) return;
      timers.clearInterval(entry.timer);
      entry.timer = null;
      const list = streams.get(accountId);
      if (!list) return;
      list.splice(list.indexOf(entry), 1);
      if (list.length === 0) streams.delete(accountId);
    };
    entry.unsubscribe = unsubscribe;
    entry.timer = timers.setInterval(() => write(entry, ': ping\n\n'), PING_MS);
    entry.timer.unref?.();

    const list = streams.get(accountId) ?? [];
    list.push(entry);
    streams.set(accountId, list);
    if (list.length > MAX_STREAMS) {
      const oldest = list[0];
      oldest.unsubscribe();
      try { oldest.res.end(); } catch { /* already gone */ }
    }

    res.on('close', unsubscribe);
    return unsubscribe;
  }

  /** Writes to one stream; a socket that has gone away drops its subscriber. */
  function write(entry, chunk) {
    try { entry.res.write(chunk); } catch { entry.unsubscribe(); }
  }

  function emit(accountId, name, data) {
    const chunk = `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const entry of [...(streams.get(accountId) ?? [])]) write(entry, chunk);
  }

  const count = (accountId) => streams.get(accountId)?.length ?? 0;

  return { subscribe, emit, count };
}
