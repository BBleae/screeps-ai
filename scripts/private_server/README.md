# Private Server Validation

The private-server checkout and validation data are kept in this project:

- `private-server/server/` contains the Screeps server checkout.
- `private-server/worlds/` contains generated validation worlds and launcher logs.

Install the checkout once with:

```bash
bash scripts/private_server/setup.sh
```

Put a real `STEAM_API_KEY` in the project `.env`. The launcher reads that value
directly (there is no `dummy` fallback), so the Steam client can authenticate to
the local server.

Run a fresh, high-speed validation with:

```bash
node scripts/private_server/run_validation.js
```

The runner seeds the world with player runners disabled, waits for an autosave
marker, restarts the server, and then runs the scenarios with one runner thread.
This avoids the private-server driver's concurrent `accessibleRooms` cache race
while still advancing the simulation at a 1 ms tick.

When `--world-dir` is omitted, the runner creates a new
`private-server/worlds/validation-*` directory. An explicit path must either be
absent/empty, or be a prepared world containing `mods.json` but no generated
rooms. Existing populated validation worlds are intentionally never overwritten
or reseeded; use a new world directory for another run.

Options:

- `--keep-running` leaves the server running and prints the game and CLI ports;
  enter `127.0.0.1:<gamePort>` in the Steam client's “Change server” dialog.
- `--world-dir <path>` selects the persistent world directory.
- `--server-dir <path>` selects a different private-server checkout.
- `--tick-duration <ms>` sets the minimum tick duration (default: `1`).
- `--warmup-ticks <n>` sets the settle period (default: `90`).
- `--max-ticks <n>` sets the validation timeout cap (default: `900`).
- `--seed-wait-ms <n>` adds a pause after the generation autosave (default: `1500`).
- `--game-port <n>` pins the HTTP game port for a stable Steam-client address.
- `--cli-port <n>` pins the administrative CLI port.
