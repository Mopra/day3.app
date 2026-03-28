/**
 * Seed script for Day3 MVP.
 *
 * Usage: npx tsx scripts/seed.ts
 *
 * Before running, make sure you have a .env.local with Supabase config.
 * This script creates starter campaigns and open tasks so the marketplace
 * isn't empty for new users.
 */

import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";

config({ path: ".env.local" });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

const TASK_INSTRUCTIONS = {
  like: "Open the target X post and like it from your real account. Then submit a short note confirming completion.",
  reply: "Write a genuine reply to the target X post. No generic spam. Submit the reply URL as proof.",
  quote: "Quote repost the target X post with your own commentary. Submit the quote post URL as proof.",
};

const CREDIT_VALUES = { like: 1, reply: 3, quote: 5 };

const SEED_CAMPAIGNS = [
  {
    title: "Help promote my new SaaS tool launch",
    description: "Just launched a productivity tool for devs. Need initial engagement on the launch tweet.",
    targetUrl: "https://x.com/example/status/1234567890",
    topics: ["SaaS", "dev tools", "launch"],
    tasks: { like: 5, reply: 3, quote: 1 },
  },
  {
    title: "Boost my AI newsletter announcement",
    description: "Weekly AI newsletter hitting 1k subscribers. Help spread the word!",
    targetUrl: "https://x.com/example/status/1234567891",
    topics: ["AI", "newsletter", "content"],
    tasks: { like: 4, reply: 2, quote: 1 },
  },
  {
    title: "Get eyes on my open source project",
    description: "Released a new React component library. Looking for engagement.",
    targetUrl: "https://x.com/example/status/1234567892",
    topics: ["open source", "React", "frontend"],
    tasks: { like: 3, reply: 2, quote: 2 },
  },
  {
    title: "Promote my design system article",
    description: "Wrote a deep dive on building design systems. Need more reach.",
    targetUrl: "https://x.com/example/status/1234567893",
    topics: ["design", "UI/UX", "article"],
    tasks: { like: 3, reply: 3, quote: 0 },
  },
  {
    title: "Share my indie hacker milestone post",
    description: "Hit $5k MRR as a solo founder. Want to celebrate and inspire others.",
    targetUrl: "https://x.com/example/status/1234567894",
    topics: ["indie hacker", "milestone", "startup"],
    tasks: { like: 5, reply: 2, quote: 1 },
  },
];

async function seed() {
  console.log("Starting seed...");

  // Seed bot user who "owns" the starter campaigns
  const { data: botUser, error: botErr } = await supabase
    .from("users")
    .insert({
      clerk_user_id: "seed-bot",
      email: "bot@day3.app",
      name: "Day3 Bot",
      username: "day3bot",
      x_handle: "@day3bot",
      bio: "Starter campaigns bot",
      interests: [],
      credits: 0,
    })
    .select("id")
    .single();

  if (botErr) {
    console.error("Failed to create bot user:", botErr);
    process.exit(1);
  }
  console.log(`Created bot user: ${botUser.id}`);

  for (const campaign of SEED_CAMPAIGNS) {
    const totalCost =
      campaign.tasks.like * CREDIT_VALUES.like +
      campaign.tasks.reply * CREDIT_VALUES.reply +
      campaign.tasks.quote * CREDIT_VALUES.quote;

    const { data: campaignRow, error: campErr } = await supabase
      .from("campaigns")
      .insert({
        owner_user_id: "seed-bot",
        title: campaign.title,
        description: campaign.description,
        target_url: campaign.targetUrl,
        topics: campaign.topics,
        status: "active",
        budget_credits: totalCost,
        remaining_credits: totalCost,
      })
      .select("id")
      .single();

    if (campErr) {
      console.error(`Failed to create campaign: ${campaign.title}`, campErr);
      continue;
    }
    console.log(`Created campaign: ${campaign.title} (${campaignRow.id})`);

    const taskTypes = [
      { type: "like" as const, count: campaign.tasks.like },
      { type: "reply" as const, count: campaign.tasks.reply },
      { type: "quote" as const, count: campaign.tasks.quote },
    ];

    const taskRows = [];
    for (const { type, count } of taskTypes) {
      for (let i = 0; i < count; i++) {
        taskRows.push({
          campaign_id: campaignRow.id,
          owner_user_id: "seed-bot",
          type,
          instructions: TASK_INSTRUCTIONS[type],
          target_url: campaign.targetUrl,
          credit_reward: CREDIT_VALUES[type],
          status: "open",
        });
      }
    }

    if (taskRows.length > 0) {
      const { error: taskErr } = await supabase.from("campaign_tasks").insert(taskRows);
      if (taskErr) {
        console.error(`  Failed to create tasks:`, taskErr);
      } else {
        console.log(`  Created ${taskRows.length} tasks`);
      }
    }
  }

  console.log("\nSeed complete!");
  process.exit(0);
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
