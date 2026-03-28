import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function deleteAll() {
  console.log("Deleting campaign_tasks...");
  const r1 = await supabase.from("campaign_tasks").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  console.log("campaign_tasks:", r1.error ? r1.error.message : "ok");

  console.log("Deleting campaigns...");
  const r2 = await supabase.from("campaigns").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  console.log("campaigns:", r2.error ? r2.error.message : "ok");

  console.log("Deleting credit_transactions...");
  const r3 = await supabase.from("credit_transactions").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  console.log("credit_transactions:", r3.error ? r3.error.message : "ok");

  console.log("Deleting users...");
  const r4 = await supabase.from("users").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  console.log("users:", r4.error ? r4.error.message : "ok");

  // Verify
  const { count: t } = await supabase.from("campaign_tasks").select("*", { count: "exact", head: true });
  const { count: c } = await supabase.from("campaigns").select("*", { count: "exact", head: true });
  const { count: ct } = await supabase.from("credit_transactions").select("*", { count: "exact", head: true });
  const { count: u } = await supabase.from("users").select("*", { count: "exact", head: true });
  console.log(`\nRemaining rows: tasks=${t}, campaigns=${c}, credit_transactions=${ct}, users=${u}`);
}

deleteAll();
