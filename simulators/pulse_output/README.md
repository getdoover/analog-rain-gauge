# pulse_output

A minimal standalone Doover app that drives a digital output on a real Doovit
via the normal platform interface (`self.set_do`).

**Behaviour**

- Every **10 days** it fires a burst of **5 pulses** on **DO 0**: each pulse
  drives the output high for 1s then low, with a 1s gap between pulses
  (whole burst takes ~9s, well within a minute).
- One burst is fired on first-ever startup so you can confirm the wiring.
- While idle it logs the time until the next burst every **15s**.

**Surviving sleep/wake.** The doovit sleeps between bursts, so the schedule is
kept in persisted tags (as an absolute wall-clock time) rather than in memory:

- `next_burst_epoch` — authoritative unix epoch of the next burst.
- `next_burst_time` — human-readable (device local time) mirror.

On each wake it reads `next_burst_epoch`: if that time has passed while asleep
it fires a burst and reschedules; otherwise it resumes counting down. The
initial burst only happens when no schedule tag exists yet (i.e. a fresh
install), so restarts/wakes never trigger a spurious burst.

Everything is configurable via env vars (see `docker-compose.yml`): `DO_PIN`,
`PULSE_COUNT`, `PULSE_HIGH_SECS`, `PULSE_GAP_SECS`, `BURST_INTERVAL_SECS`,
`REPORT_INTERVAL_SECS`.

**Run on a Doovit**

```sh
cd simulators/pulse_output
docker compose up --build -d
docker compose logs -f pulse_output
```
