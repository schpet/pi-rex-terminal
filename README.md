this is a thought experiment asking "what if my coding harness built in shell runner wasn't ass"

vibe coded as a pi plugin. i would love to see other agents support running my shell, with my aliases, tab completions, cmd-r history and all that.

slop readme follows.

---

# Pi Rex Terminal

A thought experiment in giving a coding agent an interactive terminal inside its input area. This Pi extension runs your configured shell through Rex, preserving shell abbreviations, completion, functions and history, then adds the terminal transcript to the agent's context without starting a model turn.

Captured transcripts are stored in the Pi session and included in subsequent model requests.

Requires [Pi](https://pi.dev) running inside [Rex](https://www.superlogical.com/rex), with the `rex` CLI on PATH. Tested on macOS with Node 26 and Pi 0.84.1 and 1.5.2; fish, bash and zsh support automatic return. No Pi fork or build step.

## Install

```sh
pi install git:github.com/schpet/pi-rex-terminal
```

Restart Pi inside Rex, or run `/reload` in an existing session. Press `$` in an empty editor to open the shell.

Remove with `pi remove git:github.com/schpet/pi-rex-terminal`.

## Use

- Press `$` in an empty editor. Each visit starts a fresh shell in Pi's working directory, with normal startup configuration and saved history. Directory changes and shell state do not carry between visits.
- Enter runs a command and returns automatically when it finishes in fish, bash or zsh. Multiple Enter presses disable automatic return for that visit. Ctrl+] captures and closes the shell, ending any running command; other shells require this manual return.
- The live view grows to 20 rows. Captured output folds at 20 visual lines; Pi's Ctrl+O action expands it. Agent context retains at most 32,000 characters per capture.

The shell sets `PAGER=cat`, `GIT_PAGER=cat` and `GH_PAGER=cat`; programs that ignore these remain interactive.

## Implementation and limits

Rex owns a detached terminal; Pi forwards input and draws text/cursor snapshots, polling every 220 ms and refreshing after input. Shell hooks use [OSC 7501](https://www.superlogical.com/rex/docs/build/program-status) to freeze output before the next prompt. Capture precedes block cleanup; cancellation, reload and graceful shutdown also release the block.

This is a prototype: CLI calls and polling add latency; colors and command exit codes are absent. Full-screen output and final output on shell exit can be lost; redraws can repeat earlier activity. Capture is limited to 4 MiB. Interactive startup prompts can interfere with hook installation, and setup may enter shell history. A crash or unavailable Rex server can leave a detached block behind.

## Development

From a checkout, `pi install .` loads the local source directly. Keep the checkout in place and run `/reload` after edits.

```sh
npm ci --ignore-scripts
npm run check
node --test test/*.test.ts
npm pack --dry-run
```

MIT licensed. Derived from Pi's extension example; the original license notice is retained.
