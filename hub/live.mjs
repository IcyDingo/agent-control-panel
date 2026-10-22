// The live event stream per account: the Mac's service keeps GET /api/me/events open and learns of an order the moment it is
// placed. Kept in memory only (a stream belongs to a connection, and a restart simply makes the Mac reconnect); a comment
// ping every 20 seconds keeps proxies from closing an idle stream, and an account holds at most 5 streams. Each stream
// remembers the credential that opened it (a client token's id, or a browser session), so revoking that token or signing
// that session out ends its stream at once instead of leaving it to hear orders it may no longer act on.
export const MAX_STREAMS = 5;
export const PING_MS = 20_000;

export function createLive({ timers = { setInterval, clearInterval } } = {}) {
  /** accountId -> subscribers, oldest first. */
  const streams = new Map();

  /** `by` is what opened the stream: `{ tokenId }` for a client token, `{ sessionId }` for a browser session. */
  function subscribe(accountId, res, by = {}) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 2000\n\n');

    const entry = { res, timer: null, tokenId: by.tokenId ?? null, sessionId: by.sessionId ?? null };
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
    // Over the cap, a browser tab gives way before a Mac: a tab only loses live updates (it looks again on reconnect),
    // a Mac would stop hearing orders. The oldest goes first in each kind.
    if (list.length > MAX_STREAMS) close(list.find((e) => e.tokenId === null) ?? list[0]);

    res.on('close', unsubscribe);
    return unsubscribe;
  }

  function close(entry) {
    entry.unsubscribe();
    try { entry.res.end(); } catch { /* already gone */ }
  }

  /** Ends every stream opened by a credential that matches `test`; returns how many. */
  function closeWhere(test) {
    let n = 0;
    for (const list of [...streams.values()]) for (const entry of [...list]) if (test(entry)) { close(entry); n++; }
    return n;
  }
  const closeByToken = (tokenId) => (tokenId ? closeWhere((e) => e.tokenId === tokenId) : 0);
  const closeBySession = (sessionId) => (sessionId ? closeWhere((e) => e.sessionId === sessionId) : 0);

  /** Writes to one stream; a socket that has gone away drops its subscriber. */
  function write(entry, chunk) {
    try { entry.res.write(chunk); } catch { entry.unsubscribe(); }
  }

  function emit(accountId, name, data) {
    const chunk = `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const entry of [...(streams.get(accountId) ?? [])]) write(entry, chunk);
  }

  const count = (accountId) => streams.get(accountId)?.length ?? 0;

  return { subscribe, emit, count, closeByToken, closeBySession };
}
