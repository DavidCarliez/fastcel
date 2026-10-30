# fastcel

An [Oh My Pi](https://omp.sh) plugin that starts each Vercel AI Gateway conversation on the fastest provider for its model.

Vercel AI Gateway serves many models through several providers, and their speeds differ a lot. `deepseek/deepseek-v4.1-flash` has 22 providers. On one afternoon the fastest, runware, produced a median of 370 tokens per second over the last hour, and the slowest, vertex, 24. Left to choose, the gateway sent two test requests to baseten (239 tok/s). With fastcel the same request went to runware.

## How it works

fastcel decides the order in which providers are tried. Vercel decides how long a conversation stays on the provider it landed on.

### fastcel ranks the providers

On every request OMP sends to `ai-gateway.vercel.sh`, fastcel attaches the model's providers, fastest first:

1. It reads the provider stats from `GET /v1/models/{model}/endpoints`. This is public data, the same figures shown on the model's page at vercel.com/ai-gateway/models, and needs no key. The stats are cached per model for 15 minutes. Once they are stale, requests keep using them while a refresh runs in the background.
2. It orders the providers by median throughput over the last hour. A provider goes to the back of the list when it is deprecated, when fewer than 90% of its requests succeeded in the last 15 minutes, when the request has tools and the provider does not support them, or when its context window is smaller than the conversation.
3. It sends the list as `providerOptions.gateway.order`. If the first provider fails, the gateway falls back through the rest in speed order.

fastcel keeps no memory between requests: each one carries the ranking as it stands at that moment. If the stats cannot be loaded, the request goes out unchanged and the gateway chooses as usual.

### Vercel keeps a conversation on one provider

The gateway does not simply take the first provider on the list. Its [session affinity](https://vercel.com/docs/ai-gateway/models-and-providers/session-affinity), on by default, remembers which provider answered a conversation's previous message and tries that provider first, so its prompt cache stays warm. In a session this plays out as follows:

1. **First message.** No provider is remembered yet, so the message goes to the top of fastcel's list, runware in the example above.
2. **Following messages.** They stay on runware, even if fastcel's ranking changes in the meantime.
3. **After a pause or a failure.** Vercel forgets the provider once the conversation has been idle longer than that provider's cache lifetime: about 5 minutes for most providers, 10 for OpenAI and Azure, and 1 hour for DeepSeek's own API. It also forgets it when the provider fails a request. The next message goes to whichever provider is fastest at that point, and the conversation stays there.

A new OMP session or a subagent counts as a new conversation, so it starts on whichever provider is fastest when it begins.

### Details

- **Your routing wins.** A `model@provider` selector (`vercel-ai-gateway/deepseek/deepseek-v4.1-flash@togetherai`) or `compat.vercelGatewayRouting` in `models.yml` is sent as you wrote it, and fastcel does not rank that model. OMP 18.14 drops those settings on the Anthropic Messages route it uses for every Vercel model, so fastcel sends them itself.
- **Some providers are skipped for your account.** Vercel marks some providers `plan_not_eligible` for some models. The gateway then moves on to the next provider in the list without trying the skipped one.
- **Why not `sort: "tps"`.** The gateway can sort providers by throughput itself, but in testing most providers had no value in that sort. For `openai/gpt-oss-120b` only baseten (248 tok/s) had one, so groq (480 tok/s) came after slower providers. fastcel ranks with the endpoint stats instead.

## Install

```sh
omp plugin install github:DavidCarliez/fastcel
```

From a local checkout, link it instead: `omp plugin link /path/to/fastcel`.

You need a Vercel AI Gateway key configured for OMP's `vercel-ai-gateway` provider, either in `AI_GATEWAY_API_KEY` or through `/login`. fastcel is tested with OMP 18.14.0.

## Use

Pick any Vercel AI Gateway model, with `/model` or `--model vercel-ai-gateway/deepseek/deepseek-v4.1-flash`. fastcel shows the top of its current ranking under the status line, or, in Tern's native view, on a row under the composer:

```
fastcel → runware · 370 tok/s
```

When the model's maker serves it from its own API, that provider has the maker's name, so the line marks it first-party. `fastcel → deepseek (first-party) · 191 tok/s` means DeepSeek's own API, not the DeepSeek model.

A conversation that started earlier can still be on another provider, as described above. `/fastcel` shows where the last reply actually went.

| Command            | Effect                                                                               |
| ------------------ | ------------------------------------------------------------------------------------ |
| `/fastcel`         | Ranks the current model's providers and shows which provider served the last reply. |
| `/fastcel <model>` | Ranks the providers of any gateway model, e.g. `/fastcel zai/glm-5.1`.              |
| `/fastcel refresh` | Drops cached stats and fetches them again.                                           |

`/fastcel` a minute after a reply from `deepseek/deepseek-v4.1-flash`:

```
fastcel · deepseek/deepseek-v4.1-flash · live stats, 1 min old
 1. runware         370 tok/s  ttft 1151 ms  up 100.0%
 2. togetherai      291 tok/s  ttft  309 ms  up 100.0%
 3. baseten         239 tok/s  ttft  447 ms  up 99.7%
 4. digitalocean    221 tok/s  ttft  666 ms  up 100.0%
 5. particle        196 tok/s  ttft 1657 ms  up 100.0%
 6. deepseek        193 tok/s  ttft 1662 ms  up 100.0%  (first-party)
 7. alibaba         179 tok/s  ttft 3205 ms  up 99.7%
 8. inference-net   158 tok/s  ttft  574 ms  up 100.0%
 9. parasail        155 tok/s  ttft  460 ms  up 100.0%
10. fireworks       152 tok/s  ttft 1176 ms  up 100.0%
11. gmicloud        148 tok/s  ttft 1171 ms  up 100.0%
12. novita          148 tok/s  ttft 4133 ms  up 100.0%
13. tencent         144 tok/s  ttft 1518 ms  up 100.0%
14. morph           133 tok/s  ttft 1638 ms  up 100.0%
15. pareto          123 tok/s  ttft 1360 ms  up 100.0%
16. wafer           116 tok/s  ttft  849 ms  up 99.8%
17. boundless       115 tok/s  ttft  568 ms  up 100.0%
18. modal            88 tok/s  ttft  925 ms  up 100.0%
19. relace           49 tok/s  ttft  966 ms  up 100.0%
20. deepinfra        38 tok/s  ttft  974 ms  up 100.0%
21. runinfra         33 tok/s  ttft 2564 ms  up 100.0%
22. vertex           24 tok/s  ttft  499 ms  up 100.0%
Last reply was served by runware.
```

The last line comes from Vercel's generation lookup, which uses your gateway key. Vercel publishes that record up to a minute after the reply; until then `/fastcel` says so.

To turn fastcel off, run `omp plugin disable fastcel`.

## Develop

```sh
bun install
bun test
bun run typecheck
omp -e ./src/index.ts --model vercel-ai-gateway/deepseek/deepseek-v4.1-flash
```

`src/ranking.ts` orders providers, `src/stats.ts` fetches and caches the endpoint stats, and `src/index.ts` wires both into OMP.

## License

[MIT](LICENSE)
