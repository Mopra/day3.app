import type { ClerkClient } from "@clerk/backend";
import { signupMethod } from "@/services/signup-analytics";

// How a workspace came to exist, for the admin account page.
//
// An agent can sign itself up (AgentID through the MCP OAuth flow, see
// createFirstWorkspace in src/mcp/auth.ts), and when that account then does
// something an operator has to act on, the operator needs to know two things:
// that it was an agent, and which human answers for it. AgentID hands Clerk the
// owner's email when the owner_email scope is granted; Clerk stores it on the
// external account, so that is where it is read from.
export type SignupOrigin = {
  /** "agentid" | "mcp_oauth" when the workspace was created by the MCP flow, else null. */
  createdVia: string | null;
  /** The creator's sign-in method: "google", "github", "agentid", "email". */
  method: string;
  /** True when the creator signed in through AgentID. */
  agent: boolean;
  /** The agent's (or person's) display name, as the provider gave it. */
  name: string | null;
  /** Who to contact: the AgentID owner email if granted, else the creator's primary email. */
  contactEmail: string | null;
};

export async function readSignupOrigin(clerk: ClerkClient, clerkOrgId: string): Promise<SignupOrigin | null> {
  try {
    const org = await clerk.organizations.getOrganization({ organizationId: clerkOrgId });
    const raw = (org.privateMetadata as Record<string, unknown> | undefined)?.createdVia;
    const createdVia = typeof raw === "string" ? raw : null;
    if (!org.createdBy) return { createdVia, method: "unknown", agent: false, name: null, contactEmail: null };

    const user = await clerk.users.getUser(org.createdBy);
    const agentAccount = user.externalAccounts.find((a) => /agentid/i.test(a.provider));
    const primary = user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId)?.emailAddress ?? null;
    const name =
      [user.firstName, user.lastName].filter(Boolean).join(" ").trim() || user.username || null;
    return {
      createdVia,
      method: signupMethod(user),
      agent: Boolean(agentAccount),
      name,
      contactEmail: agentAccount?.emailAddress || primary,
    };
  } catch (err) {
    // A deleted org or user, or Clerk being slow, must not break the admin page.
    console.warn(`[admin] signup origin for ${clerkOrgId} unavailable:`, err);
    return null;
  }
}
