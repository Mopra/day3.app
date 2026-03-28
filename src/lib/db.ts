import { supabase } from "./supabase";
import type {
  User,
  Campaign,
  CampaignTask,
  CampaignStatus,
  CreditTransaction,
  TaskType,
} from "./types";
import {
  CREDIT_VALUES,
  TASK_INSTRUCTIONS,
  MAX_CLAIMED_TASKS,
  SIGNUP_BONUS_CREDITS,
} from "./types";

// ---- Helpers: snake_case ↔ camelCase mapping ----

function toUser(row: Record<string, unknown>): User {
  return {
    id: row.id as string,
    clerkUserId: row.clerk_user_id as string,
    email: row.email as string,
    name: row.name as string,
    username: row.username as string,
    xHandle: row.x_handle as string,
    credits: row.credits as number,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

function toCampaign(row: Record<string, unknown>): Campaign {
  return {
    id: row.id as string,
    ownerUserId: row.owner_user_id as string,
    title: row.title as string,
    description: row.description as string,
    targetUrl: row.target_url as string,
    topics: row.topics as string[],
    status: row.status as CampaignStatus,
    budgetCredits: row.budget_credits as number,
    remainingCredits: row.remaining_credits as number,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

function toTask(row: Record<string, unknown>): CampaignTask {
  return {
    id: row.id as string,
    campaignId: row.campaign_id as string,
    ownerUserId: row.owner_user_id as string,
    type: row.type as CampaignTask["type"],
    instructions: row.instructions as string,
    targetUrl: row.target_url as string,
    creditReward: row.credit_reward as number,
    status: row.status as CampaignTask["status"],
    claimedByUserId: (row.claimed_by_user_id as string) ?? null,
    claimedAt: (row.claimed_at as Date) ?? null,
    submittedAt: (row.submitted_at as Date) ?? null,
    reviewedAt: (row.reviewed_at as Date) ?? null,
    reviewedByUserId: (row.reviewed_by_user_id as string) ?? null,
    proofText: (row.proof_text as string) ?? null,
    proofUrl: (row.proof_url as string) ?? null,
    createdAt: row.created_at as Date,
  };
}

// ---- Users ----

export async function getUserByClerkId(clerkUserId: string): Promise<User | null> {
  const { data, error } = await supabase
    .from("users")
    .select("*")
    .eq("clerk_user_id", clerkUserId)
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;
  return toUser(data);
}

export async function createOrUpdateProfile(
  clerkUserId: string,
  email: string,
  data: { name: string; xHandle: string }
) {
  const existing = await getUserByClerkId(clerkUserId);
  if (existing) {
    const { error } = await supabase
      .from("users")
      .update({
        name: data.name,
        x_handle: data.xHandle,
        updated_at: new Date().toISOString(),
      })
      .eq("id", existing.id);
    if (error) throw error;
    return existing.id;
  }

  const { data: newUser, error } = await supabase
    .from("users")
    .insert({
      clerk_user_id: clerkUserId,
      email,
      name: data.name,
      username: data.xHandle,
      x_handle: data.xHandle,
      credits: SIGNUP_BONUS_CREDITS,
    })
    .select("id")
    .single();
  if (error) throw error;

  // Record the signup bonus transaction
  const { error: txError } = await supabase.from("credit_transactions").insert({
    user_id: clerkUserId,
    type: "earned",
    amount: SIGNUP_BONUS_CREDITS,
    source_type: "signup_bonus",
    source_id: newUser.id,
    description: `Welcome bonus: ${SIGNUP_BONUS_CREDITS} credits`,
  });
  if (txError) throw txError;

  return newUser.id;
}

// ---- Tasks ----

export async function listOpenTasks(): Promise<CampaignTask[]> {
  const { data, error } = await supabase
    .from("campaign_tasks")
    .select("*")
    .eq("status", "open")
    .order("created_at", { ascending: false });

  if (error) throw error;
  return (data ?? []).map(toTask);
}

export async function getTaskById(taskId: string): Promise<CampaignTask | null> {
  const { data, error } = await supabase
    .from("campaign_tasks")
    .select("*")
    .eq("id", taskId)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;
  return toTask(data);
}

export async function getClaimedTasksCount(userId: string): Promise<number> {
  const { count, error } = await supabase
    .from("campaign_tasks")
    .select("*", { count: "exact", head: true })
    .eq("claimed_by_user_id", userId)
    .eq("status", "claimed");

  if (error) throw error;
  return count ?? 0;
}

export async function getMyClaimedTasks(userId: string): Promise<CampaignTask[]> {
  const { data, error } = await supabase
    .from("campaign_tasks")
    .select("*")
    .eq("claimed_by_user_id", userId)
    .in("status", ["claimed", "submitted"])
    .order("claimed_at", { ascending: false });

  if (error) throw error;
  return (data ?? []).map(toTask);
}

export async function claimTask(
  taskId: string,
  userId: string
): Promise<{ success: boolean; error?: string }> {
  const task = await getTaskById(taskId);
  if (!task) return { success: false, error: "Task not found" };
  if (task.status !== "open") return { success: false, error: "Task is not available" };
  if (task.ownerUserId === userId) return { success: false, error: "Cannot claim your own task" };

  const claimedCount = await getClaimedTasksCount(userId);
  if (claimedCount >= MAX_CLAIMED_TASKS) {
    return { success: false, error: `You can only have ${MAX_CLAIMED_TASKS} claimed tasks at a time` };
  }

  const { error } = await supabase
    .from("campaign_tasks")
    .update({
      status: "claimed",
      claimed_by_user_id: userId,
      claimed_at: new Date().toISOString(),
    })
    .eq("id", taskId);
  if (error) throw error;
  return { success: true };
}

export async function submitTaskProof(
  taskId: string,
  userId: string,
  proofUrl: string,
  proofText: string
): Promise<{ success: boolean; error?: string }> {
  const task = await getTaskById(taskId);
  if (!task) return { success: false, error: "Task not found" };
  if (task.status !== "claimed") return { success: false, error: "Task is not in claimed state" };
  if (task.claimedByUserId !== userId) return { success: false, error: "You did not claim this task" };

  if (task.type !== "like" && !proofUrl) {
    return { success: false, error: "Proof URL is required for this task type" };
  }

  // Check duplicate proof URL
  if (proofUrl) {
    const { data: dupes, error: dupeErr } = await supabase
      .from("campaign_tasks")
      .select("id")
      .eq("proof_url", proofUrl)
      .in("status", ["submitted", "approved"])
      .limit(1);
    if (dupeErr) throw dupeErr;
    if (dupes && dupes.length > 0) {
      return { success: false, error: "This proof URL has already been submitted" };
    }
  }

  const { error } = await supabase
    .from("campaign_tasks")
    .update({
      status: "submitted",
      proof_url: proofUrl || null,
      proof_text: proofText || null,
      submitted_at: new Date().toISOString(),
    })
    .eq("id", taskId);
  if (error) throw error;
  return { success: true };
}

// ---- Task Review (by campaign owner) ----

export async function listPendingSubmissionsForOwner(ownerUserId: string): Promise<CampaignTask[]> {
  const { data, error } = await supabase
    .from("campaign_tasks")
    .select("*")
    .eq("owner_user_id", ownerUserId)
    .eq("status", "submitted")
    .order("submitted_at", { ascending: true });

  if (error) throw error;
  return (data ?? []).map(toTask);
}

async function addCreditsToUser(clerkUserId: string, amount: number) {
  // Find by clerk_user_id first
  const { data } = await supabase
    .from("users")
    .select("id, credits")
    .eq("clerk_user_id", clerkUserId)
    .limit(1)
    .maybeSingle();

  if (data) {
    const { error } = await supabase.rpc("increment_credits", {
      row_id: data.id,
      amount,
    });
    if (error) throw error;
  }
}

export async function approveTask(
  taskId: string,
  reviewerUserId: string
): Promise<{ success: boolean; error?: string }> {
  const task = await getTaskById(taskId);
  if (!task) return { success: false, error: "Task not found" };
  if (task.status !== "submitted") return { success: false, error: "Task is not submitted" };
  if (task.ownerUserId !== reviewerUserId) {
    return { success: false, error: "Only the campaign creator can review this task" };
  }

  const { error } = await supabase
    .from("campaign_tasks")
    .update({
      status: "approved",
      reviewed_at: new Date().toISOString(),
      reviewed_by_user_id: reviewerUserId,
    })
    .eq("id", taskId);
  if (error) throw error;

  // Award credits to the user who completed the task
  await addCreditsToUser(task.claimedByUserId!, task.creditReward);

  const { error: txError } = await supabase.from("credit_transactions").insert({
    user_id: task.claimedByUserId,
    type: "earned",
    amount: task.creditReward,
    source_type: "task_approval",
    source_id: taskId,
    description: `Earned ${task.creditReward} credits for completing ${task.type} task`,
  });
  if (txError) throw txError;

  return { success: true };
}

export async function rejectTask(
  taskId: string,
  reviewerUserId: string,
  reason?: string
): Promise<{ success: boolean; error?: string }> {
  const task = await getTaskById(taskId);
  if (!task) return { success: false, error: "Task not found" };
  if (task.status !== "submitted") return { success: false, error: "Task is not submitted" };
  if (task.ownerUserId !== reviewerUserId) {
    return { success: false, error: "Only the campaign creator can review this task" };
  }

  const { error } = await supabase
    .from("campaign_tasks")
    .update({
      status: "rejected",
      reviewed_at: new Date().toISOString(),
      reviewed_by_user_id: reviewerUserId,
      ...(reason ? { rejection_reason: reason } : {}),
    })
    .eq("id", taskId);
  if (error) throw error;
  return { success: true };
}

// ---- Campaigns ----

export async function listMyCampaigns(userId: string): Promise<Campaign[]> {
  const { data, error } = await supabase
    .from("campaigns")
    .select("*")
    .eq("owner_user_id", userId)
    .order("created_at", { ascending: false });

  if (error) throw error;
  return (data ?? []).map(toCampaign);
}

export async function getCampaignById(campaignId: string): Promise<Campaign | null> {
  const { data, error } = await supabase
    .from("campaigns")
    .select("*")
    .eq("id", campaignId)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;
  return toCampaign(data);
}

export async function getCampaignTaskStats(campaignId: string) {
  const { data, error } = await supabase
    .from("campaign_tasks")
    .select("status")
    .eq("campaign_id", campaignId);

  if (error) throw error;
  const tasks = data ?? [];
  return {
    total: tasks.length,
    open: tasks.filter((t) => t.status === "open").length,
    claimed: tasks.filter((t) => t.status === "claimed").length,
    submitted: tasks.filter((t) => t.status === "submitted").length,
    approved: tasks.filter((t) => t.status === "approved").length,
    rejected: tasks.filter((t) => t.status === "rejected").length,
  };
}

export async function updateCampaign(
  campaignId: string,
  userId: string,
  data: {
    title: string;
    description: string;
    targetUrl: string;
    topics: string[];
    status: CampaignStatus;
  }
): Promise<{ success: boolean; error?: string }> {
  const campaign = await getCampaignById(campaignId);
  if (!campaign) return { success: false, error: "Campaign not found" };
  if (campaign.ownerUserId !== userId) return { success: false, error: "Not your campaign" };

  const { error } = await supabase
    .from("campaigns")
    .update({
      title: data.title,
      description: data.description,
      target_url: data.targetUrl,
      topics: data.topics,
      status: data.status,
      updated_at: new Date().toISOString(),
    })
    .eq("id", campaignId);
  if (error) throw error;

  // Also update targetUrl on all open tasks if it changed
  if (data.targetUrl !== campaign.targetUrl) {
    const { error: taskErr } = await supabase
      .from("campaign_tasks")
      .update({ target_url: data.targetUrl })
      .eq("campaign_id", campaignId)
      .eq("status", "open");
    if (taskErr) throw taskErr;
  }

  return { success: true };
}

export async function deleteCampaign(
  campaignId: string,
  userId: string
): Promise<{ success: boolean; error?: string }> {
  const campaign = await getCampaignById(campaignId);
  if (!campaign) return { success: false, error: "Campaign not found" };
  if (campaign.ownerUserId !== userId) return { success: false, error: "Not your campaign" };

  // Check for in-progress tasks (claimed or submitted)
  const { data: inProgress, error: ipErr } = await supabase
    .from("campaign_tasks")
    .select("id")
    .eq("campaign_id", campaignId)
    .in("status", ["claimed", "submitted"])
    .limit(1);
  if (ipErr) throw ipErr;
  if (inProgress && inProgress.length > 0) {
    return { success: false, error: "Cannot delete: campaign has claimed or submitted tasks" };
  }

  // Delete all open tasks
  const { error: delErr } = await supabase
    .from("campaign_tasks")
    .delete()
    .eq("campaign_id", campaignId)
    .eq("status", "open");
  if (delErr) throw delErr;

  // Refund remaining credits to the owner
  if (campaign.remainingCredits > 0) {
    await addCreditsToUser(userId, campaign.remainingCredits);
    const { error: txErr } = await supabase.from("credit_transactions").insert({
      user_id: userId,
      type: "refund",
      amount: campaign.remainingCredits,
      source_type: "campaign_creation",
      source_id: campaignId,
      description: `Refunded ${campaign.remainingCredits} credits from deleted campaign: ${campaign.title}`,
    });
    if (txErr) throw txErr;
  }

  // Delete the campaign (remaining approved/rejected tasks cascade-delete via FK)
  const { error: campErr } = await supabase
    .from("campaigns")
    .delete()
    .eq("id", campaignId);
  if (campErr) throw campErr;

  return { success: true };
}

// ---- Account Deletion (cascade) ----

export async function deleteAllUserData(clerkUserId: string): Promise<void> {
  // 1. Find the user
  const { data: user } = await supabase
    .from("users")
    .select("id")
    .eq("clerk_user_id", clerkUserId)
    .maybeSingle();

  // 2. Delete all campaigns owned by this user (tasks cascade via FK)
  const { data: campaigns } = await supabase
    .from("campaigns")
    .select("id")
    .eq("owner_user_id", clerkUserId);

  if (campaigns && campaigns.length > 0) {
    const campaignIds = campaigns.map((c) => c.id);
    await supabase.from("campaigns").delete().in("id", campaignIds);
  }

  // 3. Release tasks claimed by this user back to open
  const { data: claimedTasks } = await supabase
    .from("campaign_tasks")
    .select("id, status")
    .eq("claimed_by_user_id", clerkUserId)
    .in("status", ["claimed", "submitted"]);

  if (claimedTasks && claimedTasks.length > 0) {
    const taskIds = claimedTasks.map((t) => t.id);
    await supabase
      .from("campaign_tasks")
      .update({
        status: "open",
        claimed_by_user_id: null,
        claimed_at: null,
        submitted_at: null,
        proof_url: null,
        proof_text: null,
      })
      .in("id", taskIds);
  }

  // 4. Delete all credit transactions for this user
  await supabase.from("credit_transactions").delete().eq("user_id", clerkUserId);

  // 5. Delete the user document
  if (user) {
    await supabase.from("users").delete().eq("id", user.id);
  }
}

// ---- Create Campaign ----

export async function createCampaign(
  userId: string,
  data: {
    title: string;
    description: string;
    targetUrl: string;
    topics: string[];
    likeCount: number;
    replyCount: number;
    quoteCount: number;
  }
): Promise<{ success: boolean; error?: string; campaignId?: string }> {
  const totalCost =
    data.likeCount * CREDIT_VALUES.like +
    data.replyCount * CREDIT_VALUES.reply +
    data.quoteCount * CREDIT_VALUES.quote;

  if (totalCost <= 0) return { success: false, error: "Campaign must have at least one task" };

  // Get user and check credits
  const { data: user, error: userErr } = await supabase
    .from("users")
    .select("id, credits")
    .eq("clerk_user_id", userId)
    .maybeSingle();
  if (userErr) throw userErr;
  if (!user) return { success: false, error: "User not found" };

  if (user.credits < totalCost) {
    return { success: false, error: `Not enough credits. Need ${totalCost}, have ${user.credits}` };
  }

  // Deduct credits
  const { error: deductErr } = await supabase.rpc("increment_credits", {
    row_id: user.id,
    amount: -totalCost,
  });
  if (deductErr) throw deductErr;

  // Create campaign
  const { data: campaign, error: campErr } = await supabase
    .from("campaigns")
    .insert({
      owner_user_id: userId,
      title: data.title,
      description: data.description,
      target_url: data.targetUrl,
      topics: data.topics,
      status: "active",
      budget_credits: totalCost,
      remaining_credits: totalCost,
    })
    .select("id")
    .single();
  if (campErr) throw campErr;

  // Generate tasks
  const taskTypes: { type: TaskType; count: number }[] = [
    { type: "like", count: data.likeCount },
    { type: "reply", count: data.replyCount },
    { type: "quote", count: data.quoteCount },
  ];

  const taskRows = [];
  for (const { type, count } of taskTypes) {
    for (let i = 0; i < count; i++) {
      taskRows.push({
        campaign_id: campaign.id,
        owner_user_id: userId,
        type,
        instructions: TASK_INSTRUCTIONS[type],
        target_url: data.targetUrl,
        credit_reward: CREDIT_VALUES[type],
        status: "open",
        claimed_by_user_id: null,
        claimed_at: null,
        submitted_at: null,
        reviewed_at: null,
        reviewed_by_user_id: null,
        proof_text: null,
        proof_url: null,
      });
    }
  }

  if (taskRows.length > 0) {
    const { error: taskErr } = await supabase.from("campaign_tasks").insert(taskRows);
    if (taskErr) throw taskErr;
  }

  // Create credit transaction
  const { error: txErr } = await supabase.from("credit_transactions").insert({
    user_id: userId,
    type: "spent",
    amount: totalCost,
    source_type: "campaign_creation",
    source_id: campaign.id,
    description: `Spent ${totalCost} credits to create campaign: ${data.title}`,
  });
  if (txErr) throw txErr;

  return { success: true, campaignId: campaign.id };
}
