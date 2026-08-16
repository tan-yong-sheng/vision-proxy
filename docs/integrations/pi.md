# Pi integration

Install `vp` as a Pi extension so Pi can analyze images in your sessions.

## What it does

- Writes the `vision-proxy.ts` Pi extension into Pi's global extensions directory (`~/.pi/agent/extensions/`).
- Pi loads the extension on startup and can call `vp analyze` via the extension's tool definition.

## Install

```bash
vp integration install pi
```

## Verify

```bash
vp integration status pi
```

## Uninstall

```bash
vp integration uninstall pi
```

## What gets installed

```
~/.pi/agent/extensions/vision-proxy.ts
```

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Extension not loading | Restart Pi after installing. |
| `~/.pi/agent/extensions` does not exist | Create it manually or run Pi once so it scaffolds its config directory. |
