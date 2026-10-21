#!/usr/bin/env python3
"""Answer a background session's open plan (ExitPlanMode) the way you would on its own screen, once no hook request
holds it any more: approve it into auto or ask mode, or send it back with what to change. Prints one JSON line.

    python3 answer-plan.py <job id> '{"choice": "auto" | "default" | "feedback", "text": "<what to change>",
                                      "toolUseId": "<its ExitPlanMode call>", "transcript": "<its .jsonl>"}'

The dialog's wording and numbering depend on the session's settings ("Yes, and use auto mode" / "Yes, manually approve
edits" / "Tell Claude what to change" with a plan file; "Yes, and switch to default" / "No" without one), so the choice
is found by its words, never by a fixed number. A key goes in only when a fresh attach shows a plan dialog with nothing
like another prompt drawn after it, and Claude Code's own word agrees right before the key: `claude agents` says the
session waits on a permission prompt (which a plan is), and its transcript's open tool call is this ExitPlanMode.
"""
import fcntl, json, os, pty, re, select, signal, struct, subprocess, sys, termios, time

ANSI = re.compile(rb'\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]|\x1b[=>78]')
squash = lambda raw: re.sub(r'\s+', '', ANSI.sub(b'', raw).decode('utf8', 'replace'))
HEADS = ('Wouldyouliketoproceed?', 'Exitplanmode?')  # a plan dialog, with a plan file and without one
OTHER_DIALOG = ('Doyouwantto', 'Entertoselect', 'Typesomething.')  # a permission prompt or a question
# Which of the dialog's choices each answer is, by its words (squashed, lower case).
CHOICES = {
    'auto': lambda o: o.startswith('yes') and 'automode' in o,
    'default': lambda o: o.startswith('yes') and ('manuallyapprove' in o or 'switchtodefault' in o),
    'feedback': lambda o: o.startswith('tellclaudewhattochange'),
}


class Attached:
    def __init__(self, job):
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.environ['TERM'] = 'xterm-256color'
            os.execvp('claude', ['claude', 'attach', job])
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 140, 0, 0))
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

    def dialog(self):
        """The live plan dialog's choices as {number: words}, or {} if no plan dialog is the last thing drawn."""
        s = squash(bytes(self.buf))
        i = max(s.rfind(h) for h in HEADS)
        if i < 0 or any(m in s[i:] for m in OTHER_DIALOG):
            return {}
        return {int(n): words.lower() for n, words in re.findall(r'(?<!\d)([1-9])\.(.+?)(?=(?<!\d)[1-9]\.|$)', s[i:])}

    def calm_since(self, mark):
        """Nothing like another prompt drew since `mark`."""
        return not any(m in squash(bytes(self.buf[mark:])) for m in OTHER_DIALOG)

    def press(self, data):
        mark = len(self.buf)
        os.write(self.fd, data.encode())
        self.pump(0.5)
        return mark

    def close(self):
        try:
            os.kill(self.pid, signal.SIGTERM)
            os.waitpid(self.pid, 0)
        except OSError:
            pass


def waits_on_plan(job, tool_use_id, transcript):
    """Claude Code's own word: the session waits on a permission prompt, and its open tool call is this plan."""
    try:
        rows = json.loads(subprocess.run(['claude', 'agents', '--json', '--all'], capture_output=True, text=True, timeout=20).stdout)
    except Exception:
        return False
    row = next((r for r in rows if r.get('id') == job), None)
    if not row or row.get('status') != 'waiting' or row.get('waitingFor') != 'permission prompt':
        return False
    try:
        with open(transcript, 'rb') as f:
            f.seek(0, 2)
            f.seek(max(0, f.tell() - 512_000))
            lines = f.read().decode('utf8', 'replace').split('\n')
    except OSError:
        return False
    answered = set()
    for line in reversed(lines):
        try:
            d = json.loads(line)
        except ValueError:
            continue
        if d.get('isSidechain'):
            continue
        content = (d.get('message') or {}).get('content') if isinstance(d.get('message'), dict) else None
        if d.get('type') == 'user' and not isinstance(content, list):
            return False
        if not isinstance(content, list):
            continue
        if d.get('type') == 'user':
            answered |= {b.get('tool_use_id') for b in content if b.get('type') == 'tool_result'}
        if d.get('type') == 'assistant':
            open_calls = [b for b in content if b.get('type') == 'tool_use' and b.get('id') not in answered]
            if open_calls:
                return open_calls[-1].get('id') == tool_use_id and open_calls[-1].get('name') == 'ExitPlanMode'
    return False


def main():
    job, spec = sys.argv[1], json.loads(sys.argv[2])
    choice, text = spec.get('choice'), re.sub(r'[\x00-\x1f\x7f]+', ' ', spec.get('text') or '').strip()[:5000]
    if choice not in CHOICES or (choice == 'feedback' and not text):
        return {'ok': False, 'error': 'Approve it into auto or ask mode, or say what to change.'}
    a = Attached(job)
    try:
        if not a.pump(15, lambda: a.dialog()):
            return {'ok': False, 'error': 'Its screen is not showing the plan. Nothing was pressed.'}
        a.pump(0.6)
        options = a.dialog()
        n = next((k for k, words in sorted(options.items()) if CHOICES[choice](words)), None)
        if n is None:
            return {'ok': False, 'error': 'Its plan dialog has no such choice. Nothing was pressed. It offers: '
                    + '; '.join(f'{k}. {w}' for k, w in sorted(options.items()))[:400]}
        seen = len(a.buf)
        if not waits_on_plan(job, spec.get('toolUseId'), spec.get('transcript', '')):
            return {'ok': False, 'error': 'Claude Code no longer reports it waiting on that plan. Nothing was pressed.'}
        a.pump(0.2)
        if not a.calm_since(seen) or a.dialog() != options:
            return {'ok': False, 'error': 'Its screen changed while it checked. Nothing was pressed.'}
        mark = a.press(str(n))
        if choice == 'feedback':
            if not a.calm_since(mark):
                return {'ok': False, 'error': 'Another prompt came up on its screen, so it stopped typing.'}
            mark = a.press(text)
            if not a.calm_since(mark):
                return {'ok': False, 'error': 'Another prompt came up on its screen, so nothing was sent.'}
            a.press('\r')
        a.pump(1.2)
    finally:
        a.close()
    return {'ok': True}


if __name__ == '__main__':
    print(json.dumps(main()), flush=True)
