# CalDrop

Point it at an event poster — a photo, a screenshot, a PDF or a link — and get a
calendar file back. An OpenAI-compatible model reads the dates; you check them; the
app writes the `.ics`.

Everything runs in the browser. There is no backend.

The whole point is the step count. Share a poster in, glance at one line, tap
Add — the calendar app opens with the event already filled in.

## How it works

```
share sheet ────┐
photo / PDF ────┤                        pass 1: text model (cheap)
link / text ────┼─→ one input ─→ ────────────────┬──────────────→ nothing found?
paste / drop ───┘                                │                      │
?url= / ?text= ─┘                                │        pass 2: vision model
                                                 ▼
                                    streamed JSON via tool calling
                                                 │
                                                 ▼
                             one line + the quote it was read from
                                                 │
                              ┌──────────────────┼──────────────────┐
                              ▼                  ▼                  ▼
                       Google deeplink    Outlook deeplink       .ics file
```

- **One input** takes all of it: paste, drop, type, shoot, or share. Whether
  something is a link, plain text, an image or a PDF is the app's problem.
- **Adding to the calendar is one tap.** A `.ics` download is a file the phone
  then has to find a handler for; the Google and Outlook deep links open the
  calendar app with the event already filled in. `.ics` stays for desktop,
  multi-event exports and recurring events.
- **Verification is a glance, not a re-read.** Every event shows the verbatim
  words the date was read from — *read from "Sa 12.09. — Beginn 20 Uhr"* — so
  checking it against the poster takes a second.
- **Review is proportional to doubt.** Confident events are one line with an Add
  button. The editor opens by itself only when confidence is low or the model
  flagged something (a missing year, an ambiguous locale).
- **Photos and screenshots** are downscaled to 1600px and sent as `image_url` parts.
- **PDFs** are read with `pdfjs-dist`; when a PDF carries almost no text layer (a scan,
  or a poster with outlined type) its pages are rendered and sent as images instead.
- **Links** are fetched through a CORS proxy (browsers cannot fetch arbitrary origins),
  stripped to text, and sent as text. In a native build there is no CORS and the direct
  fetch is used.
- **Two passes**: anything with a text layer gets a cheap text-only pass first;
  the images are only sent if that finds nothing.
- **Structured output** via tool calling against a JSON Schema, with a
  `response_format: json_object` fallback for servers that don't do tools. The
  response is streamed, so the title and date appear while it is still decoding.
- **Recurring events** come back as an `RRULE` and are shown in plain language
  ("weekly on Tuesday") so the repeat gets reviewed too.
- **Times** stay floating by default — "20:00" on a poster means 20:00 where the
  event is. When the venue pins down an IANA zone, the event is written as a real
  UTC instant instead, which is exact across a timezone change and needs no
  `VTIMEZONE` block to travel.

## Getting it in front of you

Being a destination is friction: you shouldn't have to open CalDrop and *then*
find the poster again. So it is also a target.

- **Install it** (Add to Home Screen). It's a PWA — opens instantly, works offline.
- **Android share sheet**: once installed, CalDrop accepts shared images, PDFs,
  links and text directly via Web Share Target.
- **iOS**: Safari has no Share Target, so use a Shortcut (or the bookmarklet)
  pointing at `?url=` until the native build ships a Share Extension.
- **`?url=` / `?text=`**: anything can hand CalDrop a link.

  ```js
  javascript:location.href='https://jibes.github.io/cal-drop/?url='+encodeURIComponent(location.href)
  ```

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
| `VITE_PROXY_URL` | Optional shared endpoint (see `worker/`) | (unset — users bring a key) |

Any OpenAI-compatible endpoint works: OpenAI, Azure OpenAI, OpenRouter, Groq, Together,
a local Ollama or llama.cpp server. For image input the model must accept
`image_url` content parts.

### The key wall

Asking a stranger to paste an API key before the app does anything is where most
people leave. `worker/` is a small Cloudflare Worker that holds one key
server-side, allow-lists the models, and rate-limits per IP, so a first-time user
can try CalDrop with no key at all and add their own later to lift the limit.

```bash
cd worker && npx wrangler deploy && npx wrangler secret put OPENAI_API_KEY
# then build the site with VITE_PROXY_URL=https://<worker>.workers.dev/v1
```

Deploying it trades away the no-backend property, so it is opt-in: leave
`VITE_PROXY_URL` unset and CalDrop stays a pure static app where everyone brings
their own key.

> The default CORS proxy sends the target URL to a third party. Point `VITE_CORS_PROXY` at your
> own proxy, or clear it and paste page text instead, if that matters for your use.

## Check an endpoint before trusting it

OpenAI-compatible endpoints differ on exactly the things CalDrop leans on:
streaming, tool calling, image input, and whether the model reads a European
date correctly. `npm run probe` checks all four against a real endpoint, and the
last check runs the app's own extraction code — not a copy of it — over a sample
German poster:

```bash
CALDROP_BASE_URL=https://api.example.ai/v1 \
CALDROP_API_KEY=sk-... \
CALDROP_MODEL=some-model \
npm run probe
```

It exits non-zero if the endpoint cannot drive the app, and tells you when a
text-only model should be paired as `VITE_AI_TEXT_MODEL` behind a vision model.

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
- Google Calendar API integration (write without leaving the app)
- iOS Share Extension in the native build
