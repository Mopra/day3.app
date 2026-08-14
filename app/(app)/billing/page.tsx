import { requireAccount } from "@/api/context";
import { BillingView } from "./billing-view";

// Server-rendered — the account row requireAccount already resolved, so this page
// adds no query of its own.
export default async function BillingPage() {
  const { account } = await requireAccount();
  return <BillingView initialAccount={account} />;
}
