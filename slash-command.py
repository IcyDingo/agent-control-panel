#!/usr/bin/env python3
"""Run a slash command (/remote-control, /context, /compact ...) in a background session that waits at its prompt, the
way you would in claude attach: type it on its prompt line and press Enter. Claude Code takes no /command from outside a
running background job (claude --resume refuses one), so this is the way in. Prints one JSON line.

    python3 slash-command.py <job id> '/name args' <its transcript .jsonl>

It types nothing unless Claude Code says the session is idle with nothing open, and a fresh attach shows an empty prompt
line with no dialog under it. A typed slash opens the command list, where Enter runs the highlighted entry rather than
what was typed, so the command goes in with a space after its name, which closes the list. Then a second fresh attach
(the screen otherwise redraws only what changed) must show the prompt line holding exactly the command (and the
argument hint it may draw after it, like [all]), the screen above
it as it was before typing (no list, no dialog), and Claude Code must still say idle: only then is Enter pressed. If any
of that fails, the typed text is taken back off the prompt line with Backspace, and only while the screen shows it there.
It never presses Esc, Tab or an arrow. After Enter it reports what the transcript records as run, what it printed, and
whether the session is now working (the command started a turn) or waiting (it opened a view or a menu on its screen).
"""
import fcntl, json, os, pty, re, select, signal, struct, subprocess, sys, termios, time

ANSI = re.compile(rb'\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]|\x1b[=>78]')
ANSI_TEXT = re.compile(r'\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07')
squash = lambda raw: re.sub(r'\s+', '', ANSI.sub(b'', raw).decode('utf8', 'replace'))
PROMPT = '❯'
# Anything that is a dialog rather than its prompt: a permission prompt, a plan, a question, a menu.
DIALOG = ('Doyouwantto', 'Wouldyouliketoproceed', 'Tabtoamend', 'shift+tabtoapprove', 'Yes,anduseautomode',
          'Entertoselect', 'Esctocancel', 'Typesomething.', 'Entertoconfirm')
HINTS = re.compile(r'(\[[^\]]*\]|<[^>]*>)*')  # the argument hint it draws after a command's name: /context [all]
COMMAND = re.compile(r'^/[\w:.-]{1,80}( [^\x00-\x1f\x7f─❯]{0,400})?$')


class Attached:
    def __init__(self, job):
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.environ['TERM'] = 'xterm-256color'
            os.execvp('claude', ['claude', 'attach', job])
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 160, 0, 0))
        self.buf = bytearray()

    def pump(self, seconds, until=None):
        end = time.time() + seconds
        while time.time() < end:
            ready, _, _ = select.select([self.fd], [], [], 0.1)
            if ready:
                try:
                    data = os.read(self.fd, 65536)
                except OSError:
                    return False
                if not data:
                    return False
                self.buf.extend(data)
            if until and until():
                return True
        return bool(until and until())

    def line(self, since=0):
        """Its prompt line as last drawn (squashed), and whether nothing like a dialog is drawn after it."""
        s = squash(bytes(self.buf[since:]))
        i = s.rfind(PROMPT)
        if i < 0:
            return None, False
        tail = s[i + 1:]
        return tail.split('─', 1)[0], not any(m in tail for m in DIALOG)

    def above(self):
        """The last of the screen above its prompt line (squashed): what a command list or a dialog would change."""
        s = squash(bytes(self.buf))
        i = s.rfind(PROMPT)
        return s[max(0, i - 400):i] if i >= 0 else None

    def calm_since(self, mark):
        return not any(m in squash(bytes(self.buf[mark:])) for m in DIALOG)

    def press(self, data):
        mark = len(self.buf)
        os.write(self.fd, data.encode())
        return mark

    def close(self):
        try:
            os.kill(self.pid, signal.SIGTERM)
            os.waitpid(self.pid, 0)
        except OSError:
            pass


def row_of(job):
    try:
        rows = json.loads(subprocess.run(['claude', 'agents', '--json', '--all'], capture_output=True, text=True, timeout=20).stdout)
    except Exception:
        return None
    return next((r for r in rows if r.get('id') == job), None)


def at_prompt(job):
    """Claude Code's own word: the job is idle and nothing on it waits on you."""
    row = row_of(job)
    return bool(row) and row.get('status') == 'idle' and not row.get('waitingFor') and row.get('state') not in ('stopped', 'failed')


def ran_since(transcript, offset):
    """The command its transcript recorded after `offset`, and what it printed."""
    try:
        with open(transcript, 'rb') as f:
            f.seek(offset)
            lines = f.read().decode('utf8', 'replace').split('\n')
    except OSError:
        return None, ''
    ran, out = None, []
    for line in lines:
        try:
            d = json.loads(line)
        except ValueError:
            continue
        c = d.get('content') if d.get('type') == 'system' else (d.get('message') or {}).get('content') if isinstance(d.get('message'), dict) else None
        if not isinstance(c, str):
            continue
        m = re.search(r'<command-name>(/[^<]+)</command-name>', c)
        if m and ran is None:
            ran = m.group(1)
        for o in re.findall(r'<local-command-std(?:out|err)>(.*?)</local-command-std(?:out|err)>', c, re.S):
            out.append(ANSI_TEXT.sub('', o).strip())
    return ran, '\n'.join(o for o in out if o)


def main():
    job, text, transcript = sys.argv[1], sys.argv[2].strip(), sys.argv[3]
    if not COMMAND.match(text):
        return {'ok': False, 'error': 'A command is one line: /name, then its arguments.'}
    if not at_prompt(job):
        return {'ok': False, 'error': 'Claude Code does not report it idle at its prompt.'}
    try:
        offset = os.path.getsize(transcript)
    except OSError:
        return {'ok': False, 'error': 'Its conversation file is gone.'}
    keys = text if ' ' in text else text + ' '
    typed = squash(text.encode())
    left = lambda why: {'ok': False, 'typed': True, 'error': why + f' What was typed is still on its prompt line: clear it in claude attach {job}.'}

    a = Attached(job)
    try:
        empty = lambda: (lambda l, calm: l == '' and calm)(*a.line())
        if not a.pump(15, empty):
            return {'ok': False, 'error': 'Its screen is not showing an empty prompt.'}
        a.pump(0.6)
        before = a.above()
        if not empty() or not at_prompt(job):
            return {'ok': False, 'error': 'Its screen changed before anything was typed.'}
        a.pump(0.2)
        if not empty():
            return {'ok': False, 'error': 'Its screen changed before anything was typed.'}
        a.press(keys)
        a.pump(0.8)
    finally:
        a.close()

    a = Attached(job)
    try:
        holds = lambda l: l is not None and l.startswith(typed) and HINTS.fullmatch(l[len(typed):]) is not None
        shows = lambda: (lambda l, calm: holds(l) and calm)(*a.line())
        def take_back(why):
            # Backspace only lands on its prompt line: the screen shows the command there, with nothing open.
            if not shows() or not at_prompt(job):
                return left(why)
            mark = a.press('\x7f' * len(keys))
            a.pump(1.5, lambda: (lambda l, calm: l == '' and calm)(*a.line(mark)))
            return {'ok': False, 'error': why + ' What was typed was taken back off its prompt line.'}
        if not a.pump(15, shows):
            return left('Its prompt line did not show the command, so Enter was not pressed.')
        a.pump(0.6)
        if not shows():
            return left('Its screen changed, so Enter was not pressed.')
        if a.above() != before:
            return take_back('Something more than the command showed on its screen (a list or a prompt), so Enter was not pressed.')
        seen = len(a.buf)
        if not at_prompt(job):
            return left('Claude Code no longer reports it idle, so Enter was not pressed.')
        a.pump(0.2)
        if not a.calm_since(seen) or not shows():
            return left('Its screen changed, so Enter was not pressed.')
        a.press('\r')
        ran = None
        for _ in range(24):
            a.pump(0.25)
            ran, out = ran_since(transcript, offset)
            if ran:
                break
        a.pump(1.5)
        ran, out = ran_since(transcript, offset)
        row = row_of(job) or {}
        return {'ok': True, 'ran': ran, 'output': out[:4000], 'status': row.get('status')}
    finally:
        a.close()


if __name__ == '__main__':
    print(json.dumps(main()), flush=True)
