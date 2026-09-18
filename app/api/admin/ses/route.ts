import { route, json } from "@/api/http";
import { requireAdmin } from "@/api/context";
import { fetchSesAccountHealth } from "@/services/ses-account-health";

// Account-wide Amazon SES status and bounce/complaint rates, for the admin
// overview. Read live from AWS on each request: it is a staff page, opened
// rarely, and a cached number is exactly what you do not want while judging
// whether the account is about to be put on probation.
export const GET = route(async () => {
  await requireAdmin();
  return json(await fetchSesAccountHealth());
});
