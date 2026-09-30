# CalDrop fetcher

It reads a web page and hands back its text. That is the whole worker.

A browser may not fetch another site — the same-origin policy is not
negotiable from inside a page — so something on a server has to do it. The
endpoint in `worker/` already does, on the way to asking a model about the
page. This does it on its own, so that an app pointed at its own API, which
has no such route, can still read a link: fetch here, then send the text
wherever the settings point. Two steps instead of none.

## Why it asks for a code

A server that fetches on a stranger's say-so is a useful thing for a stranger
to find. It reaches what it can reach and hands back what it read, which is
how an address inside somebody's network ends up in a reply, and it launders
whoever is really asking.

The address protections — every redirect hop checked, not only the address
that was typed, plus a size cap and a content-type check — live in
`../shared/page.js`, shared with the endpoint so that the two cannot drift
apart. `ALLOWED_ORIGINS` is *not* one of those protections: it decides which
pages a browser will let call this, and decides nothing about anyone calling
it with curl, who can claim any origin. So the access code is the door, and
this refuses to serve at all until one is set — or until `ALLOW_NO_CODE` says
`yes` in as many words.

## Deploying

The *Deploy fetcher* workflow needs `CLOUDFLARE_API_TOKEN`,
`CLOUDFLARE_ACCOUNT_ID`, and `FETCHER_ACCESS_CODE`.

That last one wears two names, in two places. You set **`FETCHER_ACCESS_CODE`**
as a repository secret on GitHub; the workflow uploads it to Cloudflare as
this worker's **`ACCESS_CODE`**, which is the name the code reads. They differ
because repository secrets are one flat namespace across every workflow, and
`ACCESS_CODE` there already belongs to the endpoint — sharing it would mean
sharing the code.

Setting the secret is not enough on its own: a secret changes nothing about a
worker that is already deployed, so re-run the workflow afterwards.

## Its one route

`POST /fetch`, a JSON body of `{"url": "https://…"}`, answered with
`{"text": "…"}` — the same shape the endpoint's own `/fetch` uses, so the app
speaks to either without knowing which.
