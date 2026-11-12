#!/usr/bin/env python3
"""A terminal for the panel's embedded view: runs a command in a pseudo-terminal and relays it over pipes.

    python3 pty-bridge.py <cols> <rows> -- <command> [args...]

What the command prints goes to stdout as it comes, raw bytes. stdin carries frames from the panel, each a type byte,
a 4-byte big-endian length and that many bytes:

    d  bytes typed into the terminal
    r  a new size, as ASCII "<cols> <rows>"

When stdin closes (the panel let go, or it stopped) the command gets SIGHUP, as when a terminal window closes, and the
bridge exits with the command's status. For `claude attach`, that leaves the background session running.
Python's standard library only, as the rest of the panel's helpers.
"""
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios


def set_size(fd, cols, rows):
    cols = max(2, min(int(cols), 1000))
    rows = max(2, min(int(rows), 1000))
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))


def main():
    args = sys.argv[1:]
    if len(args) < 4 or args[2] != '--':
        sys.stderr.write('usage: pty-bridge.py <cols> <rows> -- <command> [args...]\n')
        return 2
    cols, rows, cmd = args[0], args[1], args[3:]
    pid, fd = pty.fork()
    if pid == 0:  # the child: the command, in the terminal
        os.environ.setdefault('TERM', 'xterm-256color')
        try:
            os.execvp(cmd[0], cmd)
        except OSError as e:
            sys.stderr.write(f'pty-bridge: {cmd[0]}: {e.strerror}\n')
            os._exit(127)
    set_size(fd, cols, rows)
    os.kill(pid, signal.SIGWINCH)
    inp, out = sys.stdin.buffer.raw, sys.stdout.buffer.raw
    buf = b''
    open_in = True
    while True:
        watch = [fd] + ([inp] if open_in else [])
        try:
            ready, _, _ = select.select(watch, [], [], 1.0)
        except InterruptedError:
            continue
        if fd in ready:
            try:
                data = os.read(fd, 65536)
            except OSError:  # the command closed its terminal: it is done
                data = b''
            if not data:
                break
            out.write(data)
        if open_in and inp in ready:
            chunk = os.read(inp.fileno(), 65536)
            if not chunk:  # the panel let go: hang up, as a closed window does
                open_in = False
                try:
                    os.kill(pid, signal.SIGHUP)
                except ProcessLookupError:
                    pass
                continue
            buf += chunk
            while len(buf) >= 5:
                kind, size = buf[0:1], struct.unpack('>I', buf[1:5])[0]
                if size > 1 << 20:  # not a frame from the panel: stop reading it
                    buf, open_in = b'', False
                    os.kill(pid, signal.SIGHUP)
                    break
                if len(buf) < 5 + size:
                    break
                body, buf = buf[5:5 + size], buf[5 + size:]
                if kind == b'd':
                    view = memoryview(body)
                    while view:
                        n = os.write(fd, view)
                        view = view[n:]
                elif kind == b'r':
                    try:
                        c, r = body.decode('ascii').split()
                        set_size(fd, c, r)
                        os.kill(pid, signal.SIGWINCH)
                    except (ValueError, ProcessLookupError):
                        pass
    _, status = os.waitpid(pid, 0)
    return os.waitstatus_to_exitcode(status) if hasattr(os, 'waitstatus_to_exitcode') else 0


if __name__ == '__main__':
    sys.exit(main())
