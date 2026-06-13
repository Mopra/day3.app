import { api } from "./api";
import { handleQueueBatch } from "./queue/consumer";
import { handleScheduled } from "./scheduled";
import type { QueueMessage } from "./queue/messages";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      return api.fetch(request, env, ctx);
    }
    // Anything else is a static asset / SPA route.
    return env.ASSETS.fetch(request);
  },

  async queue(batch, env) {
    await handleQueueBatch(batch as MessageBatch<QueueMessage>, env);
  },

  async scheduled(controller, env) {
    await handleScheduled(controller, env);
  },
} satisfies ExportedHandler<Env, QueueMessage>;
