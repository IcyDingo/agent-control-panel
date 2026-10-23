// What this Mac lets the hub's website make it do. The hub only queues orders; this file, which only the Mac's own user
// can change, decides whether they run. Website orders can be turned off here, only the four kinds the game knows are
// run, and builds (each one a Claude call on this Mac's account) are capped per day and counted here, so not even a hub
// that was taken over can run more than the cap.
//   web-orders.json beside the prefs: { "on": true, "buildsPerDay": 10, "day": "2026-10-23", "builds": 3 }
// A missing or broken file reads as the defaults: on, 10 builds a day.

import fs from 'node:fs';
import path from 'node:path';

export const KINDS = ['frontier', 'rocket', 'build', 'probe'];
export const BUILDS_PER_DAY = 10;
const MOST_PER_DAY = 100;

/** The day on this Mac's clock, as YYYY-MM-DD: the cap resets at local midnight. */
const localDay = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export function readPolicy(file) {
  let j = null;
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  if (!j || typeof j !== 'object' || Array.isArray(j)) j = {};
  return {
    on: j.on !== false,
    buildsPerDay: Number.isInteger(j.buildsPerDay) && j.buildsPerDay >= 0 && j.buildsPerDay <= MOST_PER_DAY ? j.buildsPerDay : BUILDS_PER_DAY,
    day: typeof j.day === 'string' ? j.day : null,
    builds: Number.isInteger(j.builds) && j.builds >= 0 ? j.builds : 0,
  };
}

function write(file, policy) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(policy) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function setOn(file, on) {
  write(file, { ...readPolicy(file), on });
  return readPolicy(file);
}

/** Null when this Mac runs a website order of this kind, else the sentence the hub shows the owner. */
export function admit(file, order) {
  if (!readPolicy(file).on) return "This Mac doesn't take orders from the website. To allow them, run  node server.mjs orders on  on the Mac.";
  if (!KINDS.includes(order?.kind)) return "This Mac doesn't know that kind of order.";
  return null;
}

/** Null when a website build may ask Claude now (and it is counted), else why not. Called just before the Claude call, so
 *  a build refused earlier (not enough credit, say) does not use up the day. */
export function takeBuild(file, now = Date.now()) {
  const p = readPolicy(file), day = localDay(now), used = p.day === day ? p.builds : 0;
  if (used >= p.buildsPerDay) {
    return `This Mac runs at most ${p.buildsPerDay} builds a day from the website, and today's are used. Build from the Mac's own panel, or again tomorrow.`;
  }
  write(file, { ...p, day, builds: used + 1 });
  return null;
}

/** One line for `node server.mjs orders`. */
export function describe(file, now = Date.now()) {
  const p = readPolicy(file), used = p.day === localDay(now) ? p.builds : 0;
  return p.on
    ? `Website orders: on (${used} of ${p.buildsPerDay} builds used today).`
    : 'Website orders: off. Builds, rockets, pushes and probes ordered on the website are refused on this Mac.';
}
