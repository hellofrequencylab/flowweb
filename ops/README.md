# Keep fwd running (FW-C-029)

`pnpm fwd` runs the daemon until you close the terminal. To keep it running across logins and restart
it after a crash, install one of these service files. Each one needs two edits: the FlowWeb folder and
a Node 22 binary. Keep the `FW_CLAUDE_AUTH` / `FW_CODEX_AUTH` lines only for the sign-ins that
`pnpm fw accounts check` reports as working. Never put a key or token in either file.

| Machine | File | Install |
|---|---|---|
| macOS | `launchd/app.flowweb.fwd.plist` | copy to `~/Library/LaunchAgents/`, then `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/app.flowweb.fwd.plist` |
| Linux | `systemd/fwd.service` | copy to `~/.config/systemd/user/`, then `systemctl --user daemon-reload && systemctl --user enable --now fwd` |

After a `git pull`, restart it: `launchctl kickstart -k gui/$(id -u)/app.flowweb.fwd` or
`systemctl --user restart fwd`. Logs go to `~/.flowweb/logs/fwd.log` (macOS) or
`journalctl --user -u fwd` (Linux).

If fwd is killed while a run is in flight, the next start marks that run interrupted. `pnpm fw doctor`
checks the setup and exits nonzero when something is broken.
