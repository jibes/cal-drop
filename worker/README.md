# CalDrop shared endpoint

A small Cloudflare Worker that fronts an OpenAI-compatible API so CalDrop can
call it from a web page. It exists for two reasons:

1. **CORS.** Most inference endpoints never answer the browser's preflight, so a
   page calling them directly fails with `Failed to fetch`. This worker answers
   it and adds the headers.
2. **The key wall.** It holds one API key server-side, so a first-time user can
   try CalDrop without pasting a key of their own.

It forwards only `POST /v1/chat/completions`, and passes the response through as
a stream so CalDrop's live preview still works.

## Deploy

```bash
cd worker
npx wrangler deploy
npx wrangler secret put OPENAI_API_KEY     # the upstream key, e.g. your Melious key
```

Then rebuild the site pointing at it — as a GitHub Actions repository *variable*
(Settings → Secrets and variables → Actions → Variables), not a secret, since it
is a public URL:

```
VITE_PROXY_URL = https://caldrop-endpoint.<subdomain>.workers.dev/v1
VITE_AI_MODEL  = gemma-4-31b
```

Confirm it before trusting it:

```bash
CALDROP_BASE_URL=https://caldrop-endpoint.<subdomain>.workers.dev/v1 \
CALDROP_API_KEY=anything \
CALDROP_MODEL=gemma-4-31b \
npm run probe
```

## Configuration

All of it lives in `wrangler.toml` under `[vars]`, so changing limits does not
mean touching code:

| Variable | Meaning |
| --- | --- |
| `ALLOWED_ORIGINS` | Comma-separated origins allowed to call it, or `*` |
| `UPSTREAM_URL` | The OpenAI-compatible API being fronted |
| `ALLOWED_MODELS` | Only these models may be requested |
| `DAILY_LIMIT` | Requests per IP per day |
| `MAX_BODY_BYTES` | Request size cap (default 12 MB) |

`OPENAI_API_KEY` is a secret, never a var — `wrangler secret put`, not
`wrangler.toml`.

### Rate limiting

Without a KV binding the daily counter lives in worker memory, which means it is
per-isolate and therefore only a speed bump. For a real quota:

```bash
npx wrangler kv namespace create RATE_LIMIT
# then uncomment the [[kv_namespaces]] block in wrangler.toml with the id it prints
```

## Test it locally

`wrangler dev` runs the worker against a local upstream, which is how the
behaviour below was verified without deploying anything:

```bash
npx wrangler dev --local
curl -i -X OPTIONS http://127.0.0.1:8787/v1/chat/completions \
  -H 'Origin: https://example.com' -H 'Access-Control-Request-Method: POST'
```

Verified locally against a mock upstream: preflight answered with the right
headers; a model outside `ALLOWED_MODELS` rejected with 400; an allowed model
proxied and streamed through; non-`/chat/completions` paths 404; `GET` 405; the
upstream key never present in any response header; and the daily limit returning
429 with a message telling the user to add their own key.
