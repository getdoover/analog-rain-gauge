# Analog Rain Gauge

<!-- ![Doover Logo](https://doover.com/wp-content/uploads/Doover-Logo-Landscape-Navy-padded-small.png) -->
<img src="https://doover.com/wp-content/uploads/Doover-Logo-Landscape-Navy-padded-small.png" alt="App Icon" style="max-width: 300px;">

**Measure and report rainfall, events and historical activity from a tipping bucket rain gauge.**

[![Version](https://img.shields.io/badge/version-1.0.0-blue.svg)](https://github.com/getdoover/analog-rain-gauge)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](https://github.com/getdoover/analog-rain-gauge/blob/main/LICENSE)

[Configuration](#configuration) | [Developer](https://github.com/getdoover/analog-rain-gauge/blob/main/DEVELOPMENT.md) | [Need Help?](#need-help)

<br/>

## Overview

Measure and report rainfall, events and historical activity from a tipping bucket rain gauge.

<br/>

## Configuration

| Setting | Description | Default |
|---------|-------------|---------|
| **Input Pin** | Input pin connected to the rain gauge | `Required` |
| **Output Pin** | Optional DO output pin connected to the rain gauge | `None` |
| **Millimeters per Pulse** | Rainfall in mm per pulse from the gauge | `0.2` |
| **Event Rainfall Threshold** | Amount of rainfall that triggers an event | `1.0` |
| **Event Completion Duration** | Hours of no rainfall to end an event | `24` |

<br/>
## Integrations

### Tags

This app exposes the following tags for integration with other apps:

| Tag | Description |
|-----|-------------|
| `since_9am` | Rainfall since 9am in mm |
| `since_event` | Rainfall since current event started in mm |
| `total_rainfall` | Total cumulative rainfall in mm |
| `event_started` | Timestamp when current rain event started |
| `last_pulse_dt` | Timestamp of last pulse from gauge |

<br/>
This app works seamlessly with:

- **Platform Interface**: Core Doover platform component


<br/>

## Need Help?

- Email: support@doover.com
- [Community Forum](https://doover.com/community)
- [Full Documentation](https://docs.doover.com)
- [Developer Documentation](https://github.com/getdoover/analog-rain-gauge/blob/main/DEVELOPMENT.md)

<br/>

## Version History

### v1.0.0 (Current)
- Initial release

<br/>

## License

This app is licensed under the [Apache License 2.0](https://github.com/getdoover/analog-rain-gauge/blob/main/LICENSE).
