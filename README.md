# Herdr Relay Bridge

Connect a Herdr agent workspace to Agent Relay so other agents can see its live state and coordinate with its fleet.

## Get started

See the [repository guide](docs/repository-guide.md) for the supported setup, current limitations and technical reference.

## License

Apache-2.0

## Platforms and live status

The fleet entrypoints are available only on Linux and macOS; they cannot be
opened on Windows. On a supported platform, open the local broker fleet with:

```sh
herdr plugin pane open --plugin agent-relay.herdr-bridge --entrypoint fleet
```

The Cloud picker is available only on Linux and macOS; it cannot be opened on Windows.
See [opening a Cloud sandbox agent](docs/repository-guide.md#open-a-cloud-sandbox-agent) for sign-in and usage.

In the live pane status, `idle` and `working` map directly; `blocked` and `blocked_on_send` map to
`blocked`. Other values, including `done`, map to `unknown` because Herdr has no `done` pane state.
