# DropToCal relay

An OpenAI-compatible API, made callable from a browser. Nothing else.

A hosted inference API answers no CORS preflight — deliberately, because a
key sent from a web page is a key given away — so a browser will not call one
however valid the key is. This worker sits in front of one and answers the
preflight. It holds no key, decides nothing, and rewrites nothing: the
caller's `Authorization` header goes through untouched, and a request that
carries none is refused rather than forwarded, which is what keeps it from
being an open relay. Whoever uses it spends their own key.

That also means the key still lives in the browser, in `localStorage`, where
anything running on that origin can read it. This removes a browser
restriction; it does not make the thing the restriction was there to prevent
safe. Use a key you are willing to have on the device, and one you can
revoke.

There used to be a second worker here that did the opposite — held a key,
picked the model and asked for an access code. It is gone; this one is all
the server DropToCal needs, and only in a browser: the app calls an API
itself.

## Deploying

The *Deploy relay* workflow needs only `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID`. There is no API key secret to set, by design.

Its URL, with `/v1` on the end, goes into Settings → **My own API** →
*API address*, alongside your own key and the model you want.

## What it does with a request

| | |
|---|---|
| `OPTIONS` | answered here, so the browser will send the real request |
| Anything else under `/v1/…` | forwarded to the same path on `UPSTREAM_URL` |
| No `Authorization` | refused with 401; nothing is forwarded |
| The response | streamed straight back, so a long answer arrives as it is written rather than all at once |

Hop-by-hop headers and cookies are dropped in both directions, and the path
is rebuilt onto the upstream base through `URL`, so `..` resolves before it
is used and cannot climb out.
