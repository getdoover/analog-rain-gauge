# pulse_output

A minimal standalone Doover app that drives two digital outputs on a real
Doovit via the normal platform interface (`self.set_do`). Each output is wired
to a voltage input, so pulsing the output produces a voltage-input pulse that a
downstream app (e.g. the rain gauge) can count.

**Behaviour**

- **DO 0** fires a single pulse **once every 10 days** (a slow heartbeat).
- **DO 1** fires a single pulse at a **random interval between 1s and 1hr**; a
  fresh random gap is chosen after every pulse.
- Each pulse drives the output high for 1s then low (`PULSE_HIGH_SECS`).
- Both outputs fire once on first-ever startup so you can confirm the wiring.
- While idle each output logs the time until its next pulse every **15s**.

**Cross-check log.** Every time an output is set (both edges of every pulse, and
the initial low on startup) a message is recorded to the `pulse_output_log`
channel (`LOG_CHANNEL`) with `{do, label, value, timestamp}`. Pins are fixed —
DO 0 is always pin 0 and DO 1 is always pin 1 — so this channel is the source of
truth for what was actually driven, to reconcile against whatever counts the
voltage input downstream.

**Surviving sleep/wake.** The doovit sleeps between pulses, so each output's
schedule is kept in persisted tags (as an absolute wall-clock time) rather than
in memory:

- `next_pulse_epoch_do0` / `next_pulse_epoch_do1` — authoritative unix epoch of
  the next pulse.
- `next_pulse_time_do0` / `next_pulse_time_do1` — human-readable (device local
  time) mirrors.

On each wake it reads the epoch tag for each output: if that time has passed
while asleep it fires a pulse and reschedules (DO 1 picking a new random gap);
otherwise it resumes counting down. The initial pulse only happens when no
schedule tag exists yet (i.e. a fresh install), so restarts/wakes never trigger
a spurious pulse.

Timing is configurable via env vars (see `docker-compose.yml`):
`DO0_INTERVAL_SECS`, `DO1_MIN_INTERVAL_SECS`, `DO1_MAX_INTERVAL_SECS`,
`PULSE_HIGH_SECS`, `REPORT_INTERVAL_SECS`, `LOOP_PERIOD_SECS`, `LOG_CHANNEL`.

**Run on a Doovit**

```sh
cd simulators/pulse_output
docker compose up --build -d
docker compose logs -f pulse_output
```
