#!/usr/bin/env python3
"""Answer a background session's open question (AskUserQuestion) the way you would on its own screen, once no hook
request holds it any more. Questions only: it never presses Esc, Tab or Shift+Tab, and it checks the screen before
every key, so nothing it sends can land in a permission prompt or a plan. Prints one JSON line.

    python3 answer-question.py <job id> '{"questions": [...], "picks": [{"option": 2} | {"other": 4, "text": "..."}],
                                          "toolUseId": "<its AskUserQuestion call>", "transcript": "<its .jsonl>"}'

Each question gets a fresh attach: a fresh attach draws the whole live screen, so its last question footer is the
dialog showing now (the screen otherwise redraws only what changed). Its answer goes in only if that dialog is a
question (it has "Type something.") showing that question, with nothing like a permission or plan prompt anywhere in
it; each further key only if nothing like one has drawn since. The screen is text anything can show, so Claude Code's
own word is needed too, right before the keys: `claude agents` says the session waits on input (a question), not on a
permission prompt (which a plan is too), and its transcript's open tool call is that question's. Several questions end
on a review screen, submitted with 1 the same way.
"""
import fcntl, json, os, pty, re, select, signal, struct, subprocess, sys, termios, time

ANSI = re.compile(rb'\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]|\x1b[=>78]')
squash = lambda raw: re.sub(r'\s+', '', ANSI.sub(b'', raw).decode('utf8', 'replace'))
FOOTER = 'Entertoselect'                 # a question dialog's footer
QUESTION_ONLY = 'Typesomething.'         # an option only a question dialog has
SUBMIT = '1.Submitanswers'               # the review screen after several questions
# A permission prompt or a plan: never press a key while one shows.
OTHER_DIALOG = ('Doyouwantto', 'Wouldyouliketoproceed', 'Tabtoamend', 'shift+tabtoapprove', 'Yes,anduseautomode')


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

    def live(self, marker, before=8000):
        """The live dialog: the text up to its last `marker`, if nothing like another dialog is in it or drew after it."""
        s = squash(bytes(self.buf))
        i = s.rfind(marker)
        if i < 0 or any(m in s[max(0, i - before):] for m in OTHER_DIALOG):
            return ''
        return s[max(0, i - before):i + len(marker)]

    def calm_since(self, mark):
        """Nothing like a permission prompt or a plan drew since `mark`."""
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


def waits_on_question(job, tool_use_id, transcript):
    """Claude Code's own word: the session waits on input, and its open tool call is this question."""
    try:
        rows = json.loads(subprocess.run(['claude', 'agents', '--json', '--all'], capture_output=True, text=True, timeout=20).stdout)
    except Exception:
        return False
    row = next((r for r in rows if r.get('id') == job), None)
    if not row or row.get('status') != 'waiting' or row.get('waitingFor') != 'input needed':
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
                return open_calls[-1].get('id') == tool_use_id and open_calls[-1].get('name') == 'AskUserQuestion'
    return False


def main():
    job, spec = sys.argv[1], json.loads(sys.argv[2])
    questions, picks = spec['questions'], spec['picks']
    confirmed = lambda: waits_on_question(job, spec.get('toolUseId'), spec.get('transcript', ''))
    if not questions or len(picks) != len(questions):
        return {'ok': False, 'error': 'Answer every question.'}
    keys = []
    for p in picks:
        if 'option' in p and isinstance(p['option'], int) and 1 <= p['option'] <= 8:
            keys.append([str(p['option'])])
        elif 'other' in p and isinstance(p['other'], int) and 2 <= p['other'] <= 9 and p.get('text', '').strip():
            keys.append([str(p['other']), re.sub(r'[\x00-\x1f\x7f]+', ' ', p['text']).strip()[:2000], '\r'])
        else:
            return {'ok': False, 'error': 'An answer is not one it can take.'}
    starts = [squash(q.encode())[:30] for q in questions]
    stopped = lambda n, why: {'ok': False, 'answered': n, 'error': why + (
        ' Nothing was pressed.' if n == 0 else f' The first {n} answer{"s" if n > 1 else ""} went in; nothing was submitted.')}

    i = 0
    while i < len(questions):
        a = Attached(job)
        try:
            is_question = lambda: (lambda f: QUESTION_ONLY in f and any(s in f for s in starts[i:]))(a.live(FOOTER))
            if not a.pump(15, is_question):
                return stopped(i, 'Its screen is not showing that question.')
            a.pump(0.6)
            frame = a.live(FOOTER)
            if QUESTION_ONLY not in frame:
                return stopped(i, 'Its screen shows something other than the question.')
            # Which question it is on (one picked before may already have gone in): the one drawn nearest its footer.
            i = max(range(i, len(questions)), key=lambda j: frame.rfind(starts[j]))
            seen = len(a.buf)
            if not confirmed():
                return stopped(i, 'Claude Code no longer reports it waiting on that question.')
            a.pump(0.2)
            if not a.calm_since(seen) or QUESTION_ONLY not in a.live(FOOTER):
                return stopped(i, 'Its screen changed while it checked.')
            mark = None
            for n, k in enumerate(keys[i]):
                if n and not a.calm_since(mark):
                    return stopped(i, 'Another prompt came up on its screen, so it stopped typing.')
                mark = a.press(k)
            a.pump(0.6)
            if not a.calm_since(mark):
                return stopped(i + 1, 'Another prompt came up on its screen.')
        finally:
            a.close()
        i += 1

    if len(questions) > 1:
        a = Attached(job)
        try:
            review = lambda: 'Reviewyouranswers' in a.live(SUBMIT, before=4000)
            if not a.pump(15, review):
                return stopped(len(questions), 'Its review screen did not come up.')
            a.pump(0.6)
            seen = len(a.buf)
            if not review() or not confirmed():
                return stopped(len(questions), 'Its review screen changed before it could submit.')
            a.pump(0.2)
            if not a.calm_since(seen) or not review():
                return stopped(len(questions), 'Its review screen changed before it could submit.')
            a.press('1')
            a.pump(1.2)
        finally:
            a.close()
    return {'ok': True}


if __name__ == '__main__':
    print(json.dumps(main()), flush=True)
