# fastcel

An [Oh My Pi](https://omp.sh) plugin that sends each Vercel AI Gateway request to the fastest provider for that model.

Vercel AI Gateway serves many models through several providers, and their speeds differ a lot. For `deepseek/deepseek-v4-flash` on one afternoon:

| Provider     | Median output speed (last hour) |
| ------------ | ------------------------------- |
| baseten      | 220 tok/s                       |
| novita       | 184 tok/s                       |
| azure        | 160 tok/s                       |
| wafer        | 158 tok/s                       |
| gmicloud     | 111 tok/s                       |
| alibaba      | 105 tok/s                       |
| deepinfra    | 51 tok/s                        |
| digitalocean | 4 tok/s                         |

Left to choose, the gateway sent the same request to alibaba. With fastcel it goes to baseten.

## How it works

Before OMP sends a request to `ai-gateway.vercel.sh`, fastcel:

1. Reads the model's provider stats from `GET /v1/models/{model}/endpoints`. This is the public data behind the throughput figures on the model's page at vercel.com/ai-gateway/models; it needs no key.
2. Orders the providers by median throughput over the last hour, fastest first.
3. Sends the whole list as `providerOptions.gateway.order`. The fastest provider gets the request; if it fails, the gateway falls back through the others in speed order.

A provider goes to the back of the list when it is deprecated, when fewer than 90% of its requests succeeded in the last 15 minutes, when the request has tools and the provider does not support them, or when its context window is smaller than the conversation.

Stats are cached per model for 15 minutes. Once they are stale, requests use them while a refresh runs in the background. If the stats cannot be loaded, the request goes out unchanged and the gateway chooses as usual.

Some details:

- **Your routing wins.** A `model@provider` selector (`vercel-ai-gateway/deepseek/deepseek-v4-flash@wafer`) or `compat.vercelGatewayRouting` in `models.yml` is sent as you wrote it, and fastcel does not rank that model. OMP 18.14 drops those settings on the Anthropic Messages route it uses for every Vercel model, so fastcel sends them itself.
- **Prompt caches stay warm.** Vercel's [session affinity](https://vercel.com/docs/ai-gateway/models-and-providers/session-affinity), on by default, puts the provider that holds a conversation's prompt cache ahead of the order fastcel sends. A conversation starts on the fastest provider and stays there while its cache is warm, even if the ranking changes in the meantime.
- **Why not `sort: "tps"`.** The gateway can sort providers by throughput itself, but in testing most providers had no value in that sort. For `openai/gpt-oss-120b` only baseten (248 tok/s) had one, so groq (480 tok/s) came after slower providers. fastcel ranks with the endpoint stats instead.

## Install

```sh
omp plugin install github:DavidCarliez/fastcel
```

From a local checkout, link it instead: `omp plugin link /path/to/fastcel`.

You need a Vercel AI Gateway key configured for OMP's `vercel-ai-gateway` provider, either in `AI_GATEWAY_API_KEY` or through `/login`. fastcel is tested with OMP 18.14.0.

## Use

Pick any Vercel AI Gateway model, with `/model` or `--model vercel-ai-gateway/deepseek/deepseek-v4-flash`. The status bar shows the provider fastcel chose:

```
fastcel → baseten 220 tok/s
```

| Command              | Effect                                                                               |
| -------------------- | ------------------------------------------------------------------------------------ |
| `/fastcel`           | Ranks the current model's providers and shows which provider served the last reply. |
| `/fastcel <model>`   | Ranks the providers of any gateway model, e.g. `/fastcel zai/glm-5.1`.              |
| `/fastcel refresh`   | Drops cached stats and fetches them again.                                           |

`/fastcel <model>` for a model with a degraded provider:

```
fastcel · deepseek/deepseek-v4-pro · live stats, just fetched
 1. azure       173 tok/s  ttft 2703 ms  up 100.0%
 2. novita       88 tok/s  ttft 1254 ms  up 100.0%
 3. deepseek     86 tok/s  ttft 1778 ms  up 100.0%
 4. deepinfra    56 tok/s  ttft 1138 ms  up 100.0%
 5. alibaba      55 tok/s  ttft 3267 ms  up 100.0%
 6. baseten      81 tok/s  ttft 1494 ms  up 88.1%  [degraded (88.1% up)]
```

For the current model, `/fastcel` adds a line such as `Last reply was served by baseten.` It comes from Vercel's generation lookup, which uses your gateway key. Vercel publishes that record up to a minute after the reply; until then `/fastcel` says so.

A provider can still be skipped for your account. Vercel marks some providers `plan_not_eligible` for some models, and the gateway then moves on to the next provider in the list without trying it. The served-by line shows where the request went.

To turn fastcel off, run `omp plugin disable fastcel`.

## Develop

```sh
bun install
bun test
bun run typecheck
omp -e ./src/index.ts --model vercel-ai-gateway/deepseek/deepseek-v4-flash
```

`src/ranking.ts` orders providers, `src/stats.ts` fetches and caches the endpoint stats, and `src/index.ts` wires both into OMP.

## License

[MIT](LICENSE)
