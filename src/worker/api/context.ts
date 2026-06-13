import type { ClerkClient } from "@clerk/backend";
import type { Db } from "../db/client";
import type { Account } from "../db/schema";

export type AuthState = {
  userId: string;
  orgId: string | null;
  has: (params: { plan: string } | { permission: string }) => boolean;
};

export type AppContext = {
  Bindings: Env;
  Variables: {
    db: Db;
    clerk: ClerkClient;
    auth: AuthState;
    account: Account;
    userEmail: string;
  };
};
