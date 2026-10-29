# Sprite pipeline providers

`generate-sprites.js` runs three paid stages — keyframe (text→image), background
removal, image→video. Which service runs them is now a flag:

```
node scripts/generate-sprites.js --provider=apiframe   # default, unchanged
node scripts/generate-sprites.js --provider=fal
```

Add `--dry-run` to price a job without spending anything.

## Why there is a choice

Apiframe is an **unofficial Midjourney proxy**. For our own game that is a
non-issue. For anything sold to someone else it is two problems:

1. **Uptime** — an unofficial proxy is not an SLA.
2. **Licence** — Midjourney's terms do not grant us the right to hand a
   customer sprites they can ship commercially. The customer's first question
   will be "can I sell a game with this?", and with Apiframe the honest answer
   is no.

`--provider=fal` exists to make the answer yes.

| | apiframe | fal |
| --- | --- | --- |
| keyframe | Midjourney (10 cr) | FLUX.1 [schnell] (2 cr / 4 variants) |
| licence | unofficial proxy — **not safe to resell** | **Apache-2.0**, model *and* outputs |
| background removal | Bria (2 cr) | Bria RMBG 2.0 (2 cr) |
| video | Kling 2.5 Turbo Pro, Kling 2.6, Seedance, Hailuo | Kling 2.5 Turbo Pro |
| 5s clip | 22 cr | 35 cr |

FLUX.1 [dev] is deliberately **not** offered: its licence forbids commercial
*generation*, which is exactly what a paid product does on a customer's behalf.
Schnell is Apache-2.0 on both the model and its outputs, so it is the only
keyframe model here that a buyer can ship a commercial game with.

fal costs more per sprite. That is the price of being able to sell the output.

## Cost is normalised to credits

1 credit = **$0.01 of provider spend**, so one number means the same thing
across providers and can be billed directly. Apiframe already prices in
credits at roughly that rate, so its numbers are unchanged.

> ⚠️ The fal USD figures in `lib/providers.js` are list prices as of
> **2026-09-30**. They are the one thing here not taken from an API schema, and
> must be re-checked against <https://fal.ai/pricing> before anyone is charged
> for a sprite.

## What stayed the same

The valuable part of the pipeline — chroma matte with edge un-mixing and
despill, cycle detection, gait tracking, scale-drift normalisation, sheet
packing — is local, free, and untouched. Only the three paid submits moved
behind an interface.

Two things were load-bearing and are preserved:

- **The end-frame pin.** fal's Kling takes it as `tail_image_url` (and wants
  `duration` as a *string*). Without an end frame a cycle cannot be returned to
  the rest pose, so a provider lacking it could not host this pipeline at all.
- **Pay-once caching.** `_work/state.json` still records a job id at submit
  time, so interrupted runs resume rather than re-pay.

## Caching across providers

Paid-job slots in `state.json` are namespaced per provider, because a cached
Midjourney keyframe must never be served to a run that asked for flux — that
would hand back art under a licence the buyer never agreed to. Apiframe keeps
the bare legacy slot names (`midjourney`, `bria`) so jobs already paid for stay
cached.

Keyframe ids likewise moved from `midjourney#1` to `apiframe:midjourney#1`,
with the legacy form canonicalised on read. This matters: without that
compatibility shim every existing character would read as a *changed* source,
which invalidates its cutout and every clip built on it. On this repo that
would have been ~200 credits of silent re-spend. `npm run test:providers` and a
`--dry-run` diff against the pre-change plan both guard it.

Switching provider on an existing character **does** re-pay, correctly: a
different model is a different picture, so the cutout and all its clips are
regenerated.

## Keys

`APIFRAME_API_KEY` / `FAL_KEY`, from the environment or `diablow/.env`.
`--dry-run` needs neither.

## Tests

```
npm run test:providers
```

26 no-network checks: response parsing for both providers, data-URI file refs,
job-id routing, cost tables, licence flags, and that the end-frame pin survives
the parameter translation.

## Adding a provider

Implement the interface at the top of `lib/providers.js` and register it in
`PROVIDERS`. The pipeline needs an image→video model that **accepts an
end-frame image**; that is the one hard requirement.
