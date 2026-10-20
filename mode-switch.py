#!/usr/bin/env python3
"""Switch a background session's permission mode the way you would by hand: attach to it in a pseudo-terminal and
press Shift+Tab until its footer shows the mode asked for. The presses go in one burst, so the session doesn't sit in
the modes in between. Prints one JSON line; the session keeps running when the client closes.

    python3 mode-switch.py <job id> <default|acceptEdits|plan|auto>
"""
import fcntl, json, os, pty, re, select, signal, struct, sys, termios, time

ORDER = ['default', 'acceptEdits', 'plan', 'auto']  # Shift+Tab's cycle, without bypass
MARKS = {'acceptEdits': r'accept\s*edits\s*on', 'plan': r'plan\s*mode\s*on', 'auto': r'auto\s*mode\s*on',
         'default': r'manual\s*mode\s*on', 'bypassPermissions': r'bypass\s*permissions\s*on'}
ANSI = re.compile(rb'\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]|\x1b[=>78]')
SHIFT_TAB = b'\x1b[Z'
SAY = {'default': 'ask mode', 'acceptEdits': 'accept-edits mode', 'plan': 'plan mode', 'auto': 'auto mode'}


def modes_in(raw):
    """Every mode named in a stretch of screen output."""
    text = ANSI.sub(b'', raw).decode('utf8', 'replace')
    return {mode for mode, pattern in MARKS.items() if re.search(pattern, text)}


def mode_in(raw):
    """The mode named last in a stretch of screen output, or None."""
    text = ANSI.sub(b'', raw).decode('utf8', 'replace')
    best, at = None, -1
    for mode, pattern in MARKS.items():
        for m in re.finditer(pattern, text):
            if m.start() > at:
                best, at = mode, m.start()
    return best


def main():
    job, target = sys.argv[1], sys.argv[2]
    if target not in ORDER:
        return {'ok': False, 'error': 'Pick ask, accept edits, plan or auto.'}
    pid, fd = pty.fork()
    if pid == 0:
        os.environ['TERM'] = 'xterm-256color'
        os.execvp('claude', ['claude', 'attach', job])
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 140, 0, 0))
    screen = bytearray()

    def pump(seconds, until=None):
        end = time.time() + seconds
        while time.time() < end:
            ready, _, _ = select.select([fd], [], [], 0.1)
            if ready:
                try:
                    data = os.read(fd, 65536)
                except OSError:
                    return False
                if not data:
                    return False
                screen.extend(data)
            if until and until():
                return True
        return bool(until and until())

    try:
        pump(15, lambda: mode_in(bytes(screen[-8000:])) is not None)
        start = mode_in(bytes(screen[-8000:]))
        if start is None:
            return {'ok': False, 'error': 'Its screen did not come up.'}
        if start == 'bypassPermissions':
            return {'ok': False, 'error': 'It is in bypass permissions. Switch it in its own terminal.'}
        if start == target:
            return {'ok': True, 'from': start, 'to': target, 'presses': 0}
        def leave_bypass():
            """Fail closed: single presses until its footer names any mode but bypass. Returns that mode, or None."""
            for _ in range(6):
                mark = len(screen)
                os.write(fd, SHIFT_TAB)
                pump(2.5, lambda: mode_in(bytes(screen[mark:])) not in (None, 'bypassPermissions'))
                seen = mode_in(bytes(screen[mark:]))
                if seen not in (None, 'bypassPermissions'):
                    return seen
            return None

        now, presses = start, 0
        for _ in range(3):  # one burst, then a single press or two if any were dropped
            n = (ORDER.index(target) - ORDER.index(now)) % len(ORDER)
            mark = len(screen)
            os.write(fd, SHIFT_TAB * n)
            presses += n
            pump(3, lambda: mode_in(bytes(screen[mark:])) == target)
            pump(0.4)
            seen = mode_in(bytes(screen[mark:]))
            # Its cycle has bypass in it (it was started with bypass allowed), so the presses don't add up. Get it out
            # of bypass before anything else, and leave switching it to its own terminal.
            if seen == 'bypassPermissions' or 'bypassPermissions' in modes_in(bytes(screen[mark:])):
                out = leave_bypass() if seen in (None, 'bypassPermissions') else seen
                if out is None:
                    return {'ok': False, 'stuck': True, 'error': 'Its Shift+Tab cycle includes bypass permissions and it is still in it. Switch it in its own terminal now.'}
                return {'ok': False, 'from': start, 'to': out,
                        'error': f'Its Shift+Tab cycle includes bypass permissions, so it is not switched from here. It is in {SAY.get(out, out)} now; switch it in its own terminal.'}
            if seen is None:
                # No footer after the presses: check where it stands before giving up, and never leave it in bypass.
                if mode_in(bytes(screen[-8000:])) == 'bypassPermissions' and leave_bypass() is None:
                    return {'ok': False, 'stuck': True, 'error': 'It is in bypass permissions. Switch it in its own terminal now.'}
                return {'ok': False, 'error': 'Its footer did not change after Shift+Tab.', 'from': start}
            now = seen
            if now == target:
                return {'ok': True, 'from': start, 'to': target, 'presses': presses}
        return {'ok': False, 'error': f'It ended up in {SAY.get(now, now)}.', 'from': start, 'to': now}
    finally:
        try:
            os.kill(pid, signal.SIGTERM)
            os.waitpid(pid, 0)
        except OSError:
            pass


if __name__ == '__main__':
    print(json.dumps(main()), flush=True)
