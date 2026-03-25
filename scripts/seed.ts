/**
 * Seed script for Day3 MVP.
 *
 * Usage: npx tsx scripts/seed.ts
 *
 * Before running, make sure you have a .env.local with Firebase config.
 * This script creates starter campaigns and open tasks so the marketplace
 * isn't empty for new users.
 */

import { initializeApp } from "firebase/app";
import { getFirestore, collection, addDoc, Timestamp } from "firebase/firestore";
import { config } from "dotenv";

config({ path: ".env.local" });

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app, "day3");

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
  const botRef = await addDoc(collection(db, "users"), {
    clerkUserId: "seed-bot",
    email: "bot@day3.app",
    name: "Day3 Bot",
    username: "day3bot",
    xHandle: "@day3bot",
    bio: "Starter campaigns bot",
    interests: [],
    credits: 0,
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
  });
  console.log(`Created bot user: ${botRef.id}`);

  for (const campaign of SEED_CAMPAIGNS) {
    const totalCost =
      campaign.tasks.like * CREDIT_VALUES.like +
      campaign.tasks.reply * CREDIT_VALUES.reply +
      campaign.tasks.quote * CREDIT_VALUES.quote;

    const campaignRef = await addDoc(collection(db, "campaigns"), {
      ownerUserId: "seed-bot",
      title: campaign.title,
      description: campaign.description,
      targetUrl: campaign.targetUrl,
      topics: campaign.topics,
      status: "active",
      budgetCredits: totalCost,
      remainingCredits: totalCost,
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    });

    console.log(`Created campaign: ${campaign.title} (${campaignRef.id})`);

    const taskTypes = [
      { type: "like" as const, count: campaign.tasks.like },
      { type: "reply" as const, count: campaign.tasks.reply },
      { type: "quote" as const, count: campaign.tasks.quote },
    ];

    let taskCount = 0;
    for (const { type, count } of taskTypes) {
      for (let i = 0; i < count; i++) {
        await addDoc(collection(db, "campaignTasks"), {
          campaignId: campaignRef.id,
          ownerUserId: "seed-bot",
          type,
          instructions: TASK_INSTRUCTIONS[type],
          targetUrl: campaign.targetUrl,
          creditReward: CREDIT_VALUES[type],
          status: "open",
          claimedByUserId: null,
          claimedAt: null,
          submittedAt: null,
          reviewedAt: null,
          reviewedByUserId: null,
          proofText: null,
          proofUrl: null,
          createdAt: Timestamp.now(),
        });
        taskCount++;
      }
    }
    console.log(`  Created ${taskCount} tasks`);
  }

  console.log("\nSeed complete!");
  process.exit(0);
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
