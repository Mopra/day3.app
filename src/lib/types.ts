export interface User {
  id: string;
  clerkUserId: string;
  email: string;
  name: string;
  username: string;
  xHandle: string;
  credits: number;
  createdAt: Date;
  updatedAt: Date;
}

export type CampaignStatus = "draft" | "active" | "paused" | "completed";

export interface Campaign {
  id: string;
  ownerUserId: string;
  title: string;
  description: string;
  targetUrl: string;
  topics: string[];
  status: CampaignStatus;
  budgetCredits: number;
  remainingCredits: number;
  createdAt: Date;
  updatedAt: Date;
}

export type TaskType = "like" | "reply" | "quote";
export type TaskStatus = "open" | "claimed" | "submitted" | "approved" | "rejected";

export interface CampaignTask {
  id: string;
  campaignId: string;
  ownerUserId: string;
  type: TaskType;
  instructions: string;
  targetUrl: string;
  creditReward: number;
  status: TaskStatus;
  claimedByUserId: string | null;
  claimedAt: Date | null;
  submittedAt: Date | null;
  reviewedAt: Date | null;
  reviewedByUserId: string | null;
  proofText: string | null;
  proofUrl: string | null;
  createdAt: Date;
}

export type TransactionType = "earned" | "spent" | "refund";
export type SourceType = "task_approval" | "campaign_creation" | "signup_bonus";

export interface CreditTransaction {
  id: string;
  userId: string;
  type: TransactionType;
  amount: number;
  sourceType: SourceType;
  sourceId: string;
  description: string;
  createdAt: Date;
}

export const CREDIT_VALUES: Record<TaskType, number> = {
  like: 1,
  reply: 3,
  quote: 5,
};

export const TASK_INSTRUCTIONS: Record<TaskType, string> = {
  like: "Open the target X post and like it from your real account. Then submit a short note confirming completion.",
  reply: "Write a genuine reply to the target X post. No generic spam. Submit the reply URL as proof.",
  quote: "Quote repost the target X post with your own commentary. Submit the quote post URL as proof.",
};

export const MAX_CLAIMED_TASKS = 3;

export const SIGNUP_BONUS_CREDITS = 25;
