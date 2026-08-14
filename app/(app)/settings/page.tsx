import { requireAccount } from "@/api/context";
import { SettingsView } from "./settings-view";

// Server-rendered. This page reads nothing beyond the account row requireAccount
// already resolves, so it costs no query of its own — where the client-fetch
// version spent a whole round trip fetching what the server had in hand.
export default async function SettingsPage() {
  const { account } = await requireAccount();
  return <SettingsView account={account} />;
}
