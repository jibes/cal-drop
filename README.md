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
- **Links** are read by the endpoint, not the browser: it fetches the page,
  strips it to text and hands that back. No CORS proxy to configure, and no
  third party sees the links people paste.
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

There is one setting in the app: an **access code**. Everything else is a
property of the deployment, not a choice to put in front of someone holding a
poster.

| Decision | Where it lives |
| --- | --- |
| Which endpoint the app calls | `VITE_PROXY_URL`, committed in `.env.production` |
| Which model reads the posters | `MODEL` in `worker/wrangler.toml` |
| Which key pays for it | `OPENAI_API_KEY`, a Worker secret |
| Who may call it | `ACCESS_CODE` secret + `ALLOWED_ORIGINS` |
| How often | `DAILY_LIMIT` per IP |

The endpoint URL is not a secret — it is inlined into the public bundle, and
anyone who opens the app can read it. The access code is, which is why it is
never built in: each person enters it once and it stays in their browser.

The endpoint ignores whatever model the page asks for and substitutes its own,
so there is exactly one answer to "which model answered this", and no caller can
spend the operator's credits on something more expensive.

Forking works the same way: point `VITE_PROXY_URL` at your own worker, set its
`MODEL` and `UPSTREAM_URL`, and the app follows.

## "Failed to fetch"

This is a browser-level failure, not an API error: the request never left the
page. Almost always it is CORS. Sending an `Authorization` header with a JSON
body makes the request non-simple, so the browser sends a `OPTIONS` preflight
first, and many inference endpoints never answer it — they are built to be
called from a server, not from a web page.

It has nothing to do with which input you picked; photos, PDFs, links and text
all fail identically. Confirm it in the browser console, where the block is
named outright, or from a terminal:

```bash
curl -i -X OPTIONS https://your-api/v1/chat/completions \
  -H "Origin: https://<your-pages-origin>" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: authorization,content-type"
```

No `access-control-allow-origin` in the response means CORS is the cause. Three
ways out:

1. Enable CORS for your origin on the API, if you control it.
2. Use a provider that allows browser calls.
3. Put `worker/` in front of it — it answers the preflight, adds the headers and
   keeps the key server-side. This is what it is for.

## Check an endpoint before trusting it

OpenAI-compatible endpoints differ on exactly the things CalDrop leans on:
streaming, tool calling, image input, and whether the model reads a European
date correctly. `npm run probe` checks all four against a real endpoint, and the
last check runs the app's own extraction code — not a copy of it — over a sample
German poster:

```bash
CALDROP_BASE_URL=https://your-worker.workers.dev/v1 \
CALDROP_ACCESS_CODE=... \
npm run probe
```

It checks streaming, tool calling, the `json_object` fallback, image input and
link reading, then runs the app's own extraction over a sample German poster. It
exits non-zero if the endpoint cannot drive the app.

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
