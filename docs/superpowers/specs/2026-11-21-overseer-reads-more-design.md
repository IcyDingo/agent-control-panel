# Ask Glue reads more, and says what is new

## Why
The owner found the home agent (Ask Glue, the overseer) too vague, weak in what it suggests, sometimes wrong, and
repetitive: it re-listed the same agents and pull requests in every answer. Most of that was structural. It has no
tools, got about 280 characters of each agent's last message, could open two transcripts per question, and saw only
words, never what an agent ran, changed or failed.

## Goals
- It can say what an agent did, why it stopped and what is left, with the file, check or command named.
- The messages it drafts for agents name the concrete thing, not "please continue".
- What it says is true to the board: no start time passed off as idle time, no agent that needs the owner left out.
- It says what is new since its last answer instead of everything again.

## Non-goals
- No tools for the model, and no action without a click. Both stay exactly as they were.
- No change to follow-up cards, the PR watcher, or what Home shows.
- Existing workspaces keep the model they have.

## Anti-goals
- Nothing an agent, CI or GitHub wrote may reach the model as anything but data with its tags taken out.
- A look must never read a session, repository or run of another workspace.

## Approaches
- **Keep it tool-less; let it ask the panel for more, and rewrite its brief (picked).** Safe against what agents write,
  cheap, and it fixes the causes found.
- Give it read-only tools in the repositories: slower and costlier, and agents' output could then steer something that
  can act.
- Only rewrite the brief: wording cannot make up for what it never sees.

## What was wrong (each fixed)
| | Cause |
|---|---|
| C1 | The time after a state was the session's start time, shown as "idle 3m", and used for sorting. |
| C2 | The last message had no age, and for a working session was from the turn before. |
| C3 | The last message was the final line of a block cut at 600 characters, so it was lost when there was a follow-up or asks. |
| C4 | An idle session with a follow-up, or a failed one, sorted behind every working one; past 24 it was never named. |
| C5 | The board was cut blind at 18,000 characters, losing GitHub and then the launch folders. |
| C6 | "Has conflicts" and "ready to merge" were never on the session's own line. |
| C7 | A long earlier answer was clipped twice, so what became of its proposals dropped off. |
| C8 | Excerpts dropped notes such as "Claude stopped at its usage limit". |
| C9 | Excerpts cut a long final message from its start, losing the question at its end. |
| C10 | PR watcher cards were replayed as the overseer's own earlier answers. |

## Design
- **The prompt goes in on stdin**, not argv, so it can be 120,000 characters (was 48,000).
- **The board.** Order: needs you, then sessions the owner named, then follow-up or failed, working, idle, finished; the
  one that spoke last first. Each block says `started 2d ago`, and what it said with its own age (`said 4m ago`, or
  `said before this turn, 12m ago` for a working one). Everything but what it said is cut to 600 characters; what it
  said is appended after that, never cut off by it. The merge state is on the session's line.
- **Notes sized by need.** The first eight sessions that need the owner, were named, failed, have a follow-up or
  failing checks, or did something since the last answer get 1,500 characters; the next eight blocks 500; the rest 160.
  Twenty-four sessions get a block, the next thirty-six one line with their id.
- **What is new.** A session with a feed event or a message since the overseer's last own answer is marked `new`. The
  feed carries a line where that answer was. Above the owner's message the prompt says how much is new, or that nothing
  is. The newest earlier answer is shown up to 3,000 characters, with its proposals' outcomes kept whole.
- **Looks.** Up to four at once, in two rounds at most, each bounded at twenty seconds:
  - `chat`: from the Nth-last message (up to 20) to the end: what was said (a long message keeps both ends), each tool
    call in a line, failed results, and notes.
  - `log`: the failing part of the CI log. The model names a session; the panel takes the run from its last GitHub poll.
  - `changes`: `git status --short --branch`, `git diff --stat HEAD` and the last eight commits in the session's
    folder, run by the panel with fixed arguments and `--no-optional-locks`.
- **The brief** keeps the no-tools, data-not-instructions and propose-only paragraphs, and adds: look before answering
  what an agent did or writing to one; start with the answer; name the concrete thing; don't repeat earlier answers;
  say plainly what could not be seen.
- **Model and time.** A new workspace starts on Opus. One call may take 120 s, one answer six minutes.
- **An answer's retries are let through.** A real Opus call was seen to take a third turn with no tool refused and no
  subagent: its first try did not fit the schema, and Claude Code had it try again. That valid answer was being thrown
  away as "tried to do more than answer". Up to four turns now pass; a refused tool, a subagent or more turns than that
  still discard the answer. It is offered no tools either way.
- **Questions and plans in a look.** A look at a conversation shows a question the agent put to the owner with its
  choices, and a plan waiting for approval, since those are what the owner would need to answer.

## Constraints
- Node standard library only; the page changes by one label ("read fix-login's CI log").
- Both new looks are guarded like the transcript look: the session is in the overseer's own workspace and not in
  another workspace's repository; the model gives no path, slug, run id or command.

## Left out on purpose
A third round of looks, diffs against the base branch, and moving existing workspaces to Opus.
