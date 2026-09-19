# CalDrop shared endpoint

A small Cloudflare Worker that fronts an OpenAI-compatible API so CalDrop can
call it from a web page. It exists for two reasons:

1. **CORS.** Most inference endpoints never answer the browser's preflight, so a
   page calling them directly fails with `Failed to fetch`. This worker answers
   it and adds the headers.
2. **The key wall.** It holds one API key server-side, so a first-time user can
   try CalDrop without pasting a key of their own.

It serves two routes:

- `POST /v1/chat/completions` — forwarded upstream with **the model replaced by
  its own**, and streamed straight back so the app's live preview still works.
  No caller can pick a more expensive model than the operator chose.
  Redirects are followed manually so the POST stays a POST: `fetch` turns a
  redirected POST into a GET, and an API behind nginx answers that with
  `405 Not Allowed`, which reads like a rejected request rather than a
  rewritten one.
- `POST /v1/fetch` — `{ url }` in, `{ text }` out. Event links are read here
  rather than in the browser, so there is no CORS proxy to configure and no
  third party sees the links. Only http(s) is followed, private and
  link-local addresses are refused, and the response is capped.

## Deploy without a terminal (phone-friendly)

`.github/workflows/deploy-worker.yml` does the deploy in CI, so the whole thing
is browser-only. Add three repository **secrets** under
Settings → Secrets and variables → Actions → Secrets:

| Secret | Where it comes from |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Cloudflare dashboard → My Profile → API Tokens → Create Token → **Edit Cloudflare Workers** template |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare dashboard → Workers & Pages → the ID in the right-hand sidebar (also in the dashboard URL) |
| `UPSTREAM_API_KEY` | The upstream API key. The workflow uploads it as the Worker secret `OPENAI_API_KEY`; it is never written into `wrangler.toml` or the site bundle |
| `ACCESS_CODE` | **Optional.** A shared code callers must present. Without it, anyone who finds the endpoint URL can spend your credits |

Then Actions → *Deploy shared endpoint* → **Run workflow**. The run summary
prints the endpoint URL to use for `VITE_PROXY_URL`.

## Deploy from a terminal

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
```

The model is not named here: the endpoint picks it, so there is one place to
change it and no way for a caller to override it.

Confirm it before trusting it:

```bash
CALDROP_BASE_URL=https://caldrop-endpoint.<subdomain>.workers.dev/v1 \
CALDROP_ACCESS_CODE=<your access code> \
npm run probe
```

## Keeping other people off your credits

A `workers.dev` URL is public, and the site that calls it is public too. Two
things guard it, and they guard different attackers:

- **Origin.** A browser on any origin other than `ALLOWED_ORIGINS` is refused
  with 403. This stops another web page from using your endpoint, but it is not
  a defence against anything that is not a browser, since a script sets whatever
  Origin it likes — or none.
- **`ACCESS_CODE`.** A shared secret callers must send as a bearer token, held
  as a Worker secret and compared in constant time. This is the one that
  actually limits who can spend your credits.

The code cannot be baked into the site: everything in the bundle is readable by
anyone who opens devtools. So each person enters it once in Settings, in the
API key field, and it stays in their browser's storage. Tell it to the people
you want to have it; rotate it by changing the secret and re-running the deploy.

Without `ACCESS_CODE` set, the endpoint is open to anyone who learns the URL,
and the only limit is `DAILY_LIMIT` per IP — which an attacker with several
addresses walks straight past.

## When something upstream fails

An upstream failure is never the caller's to fix — their access code was
already checked — so it is not passed through as their status:

| upstream | what the app sees |
| --- | --- |
| 401 / 403 | `502` — the provider rejected **this endpoint's** key, not the user's access code |
| 429 | `429` — the provider is rate limiting |
| 400 / 404 / 422 | passed through, so the app can retry without tool calling |
| anything else | `502` with the upstream status, final URL and a one-line summary |

Passing a bare upstream 401 through would tell the user their access code is
wrong when the operator's key is what was rejected — so those two cases must
never share a status. HTML error pages are reduced to a line, because an nginx
error page in a UI tells the reader nothing.

## Configuration

All of it lives in `wrangler.toml` under `[vars]`, so changing limits does not
mean touching code:

| Variable | Meaning |
| --- | --- |
| `ALLOWED_ORIGINS` | Comma-separated origins allowed to call it, or `*` |
| `UPSTREAM_URL` | The OpenAI-compatible API being fronted |
| `MODEL` | The one model this endpoint answers with. Whatever the app sends is discarded |
| `UPSTREAM_URL` | Base URL of the API being fronted, without a trailing slash |
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
headers; a model named by the caller discarded in favour of the endpoint's own;
the response proxied and streamed through; unknown paths 404; `GET` 405; the
upstream key never present in any response header; the daily limit returning 429
with `Retry-After`; a missing access code and a wrong one both 401; a foreign
Origin 403; and `/fetch` refusing loopback, private, link-local and non-http
addresses.
