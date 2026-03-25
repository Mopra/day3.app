"use server";

import { auth } from "@clerk/nextjs/server";
import {
  createCampaign as dbCreateCampaign,
  updateCampaign as dbUpdateCampaign,
  deleteCampaign as dbDeleteCampaign,
  listMyCampaigns,
  listPendingSubmissionsForOwner,
  getCampaignById,
  approveTask as dbApproveTask,
  rejectTask as dbRejectTask,
} from "@/lib/db";
import { campaignSchema, campaignEditSchema } from "@/lib/validators";
import { serialize } from "@/lib/firebase";

export async function fetchMyCampaigns() {
  const { userId } = await auth();
  if (!userId) return [];
  const campaigns = await listMyCampaigns(userId);
  return serialize(campaigns);
}

export async function createCampaignAction(formData: FormData) {
  const { userId } = await auth();
  if (!userId) return { success: false, error: "Not authenticated" };

  const raw = {
    title: formData.get("title") as string,
    description: formData.get("description") as string,
    targetUrl: formData.get("targetUrl") as string,
    topics: formData.get("topics") as string,
    likeCount: formData.get("likeCount") as string,
    replyCount: formData.get("replyCount") as string,
    quoteCount: formData.get("quoteCount") as string,
  };

  const parsed = campaignSchema.parse(raw);
  const topics = parsed.topics
    ? parsed.topics.split(",").map((s) => s.trim()).filter(Boolean)
    : [];

  return dbCreateCampaign(userId, {
    title: parsed.title,
    description: parsed.description,
    targetUrl: parsed.targetUrl,
    topics,
    likeCount: parsed.likeCount,
    replyCount: parsed.replyCount,
    quoteCount: parsed.quoteCount,
  });
}

export async function fetchCampaignById(campaignId: string) {
  const { userId } = await auth();
  if (!userId) return null;
  const campaign = await getCampaignById(campaignId);
  if (!campaign || campaign.ownerUserId !== userId) return null;
  return serialize(campaign);
}

export async function fetchMyPendingSubmissions() {
  const { userId } = await auth();
  console.log("[fetchMyPendingSubmissions] userId:", userId);
  if (!userId) return [];
  try {
    const results = await listPendingSubmissionsForOwner(userId);
    console.log("[fetchMyPendingSubmissions] results count:", results.length);
    return serialize(results);
  } catch (err) {
    console.error("[fetchMyPendingSubmissions] ERROR:", err);
    throw err;
  }
}

export async function updateCampaignAction(campaignId: string, formData: FormData) {
  const { userId } = await auth();
  if (!userId) return { success: false, error: "Not authenticated" };

  const raw = {
    title: formData.get("title") as string,
    description: formData.get("description") as string,
    targetUrl: formData.get("targetUrl") as string,
    topics: formData.get("topics") as string,
    status: formData.get("status") as string,
  };

  const parsed = campaignEditSchema.parse(raw);
  const topics = parsed.topics
    ? parsed.topics.split(",").map((s) => s.trim()).filter(Boolean)
    : [];

  return dbUpdateCampaign(campaignId, userId, {
    title: parsed.title,
    description: parsed.description,
    targetUrl: parsed.targetUrl,
    topics,
    status: parsed.status,
  });
}

export async function deleteCampaignAction(campaignId: string) {
  const { userId } = await auth();
  if (!userId) return { success: false, error: "Not authenticated" };
  return dbDeleteCampaign(campaignId, userId);
}

export async function approveTaskAction(taskId: string) {
  const { userId } = await auth();
  if (!userId) return { success: false, error: "Not authenticated" };
  return dbApproveTask(taskId, userId);
}

export async function rejectTaskAction(taskId: string, reason?: string) {
  const { userId } = await auth();
  if (!userId) return { success: false, error: "Not authenticated" };
  return dbRejectTask(taskId, userId, reason);
}
