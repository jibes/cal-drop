# CalDrop

Point it at an event poster — a photo, a screenshot, a PDF or a link — and get a
calendar file back. An OpenAI-compatible model reads the dates; you check them; the
app writes the `.ics`.

Everything runs in the browser. There is no backend.

## How it works

```
photo / screenshot ─┐
PDF ────────────────┼─→ image or text ─→ OpenAI-compatible chat completions
event link ─────────┤                     (vision + JSON output)
pasted text ────────┘                              │
                                                   ▼
                                     review & edit the extracted events
                                                   │
                                                   ▼
                                              events.ics
```

- **Photos and screenshots** are downscaled to 1600px and sent as `image_url` parts.
- **PDFs** are read with `pdfjs-dist`; when a PDF carries almost no text layer (a scan,
  or a poster with outlined type) its pages are rendered and sent as images instead.
- **Links** are fetched through a CORS proxy (browsers cannot fetch arbitrary origins),
  stripped to text, and sent as text. In a native build there is no CORS and the direct
  fetch is used.
- **Dates** come back as floating local times — "20:00" on a poster means 20:00 where the
  event is, so no timezone conversion is applied.

## Configuration

The API key is **not** a build-time setting. GitHub Pages serves a static bundle, so
anything compiled in is readable by anyone who opens devtools. Each user enters their own
key in Settings; it is kept in `localStorage` on their device and sent only to the
endpoint they configured.

Build-time env vars supply non-secret defaults only (see `.env.example`):

| Variable | Purpose | Default |
| --- | --- | --- |
| `VITE_AI_BASE_URL` | OpenAI-compatible base URL | `https://api.openai.com/v1` |
| `VITE_AI_MODEL` | Vision-capable model | `gpt-4o-mini` |
| `VITE_AI_TEXT_MODEL` | Optional cheaper model for links/text | (falls back to `VITE_AI_MODEL`) |
| `VITE_CORS_PROXY` | Proxy template, `{url}` is substituted | `https://r.jina.ai/{url}` |

Any OpenAI-compatible endpoint works: OpenAI, Azure OpenAI, OpenRouter, Groq, Together,
a local Ollama or llama.cpp server. For image input the model must accept
`image_url` content parts.

> The default proxy sends the target URL to a third party. Point `VITE_CORS_PROXY` at your
> own proxy, or clear it and paste page text instead, if that matters for your use.

## Develop

```bash
npm install
cp .env.example .env.local   # optional, non-secret defaults
npm run dev
```

`npm run build` produces a static `dist/`. `base` is `./`, so the same build works from a
GitHub Pages project subpath and from a native WebView.

## Deploy

`.github/workflows/deploy.yml` builds and publishes on every push to `main`. Enable it
once under **Settings → Pages → Source: GitHub Actions**. Set the non-secret defaults as
repository *variables* (Settings → Secrets and variables → Actions → Variables) if you
want them baked in.

## Native builds

The web build is Capacitor-ready — same code, wrapped in a native shell:

```bash
npm install @capacitor/core @capacitor/cli @capacitor/camera @capacitor/filesystem
npm run build
npx cap add android      # and/or: npx cap add ios
npx cap sync
npx cap open android
```

`capacitor.config.json` already points `webDir` at `dist`. Native builds should then swap
in the platform pieces: `@capacitor/camera` for capture, `@capacitor/filesystem` +
`Share` for saving the `.ics`, and secure storage for the API key. The extraction and ICS
code is plain TypeScript with no DOM assumptions beyond canvas, so it carries over as is.

## Roadmap

- CalDAV upload
- Google Calendar integration
- Recurring events (`RRULE`)
