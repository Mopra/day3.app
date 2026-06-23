import { route, json } from "@/api/http";
import { requireAccount } from "@/api/context";
import { aiEnabled } from "@/services/ai";

// Lets the composer hide the AI affordances entirely when OpenRouter isn't
// configured, so users never see a button that only errors.
export const GET = route(async () => {
  await requireAccount();
  return json({ enabled: aiEnabled() });
});
