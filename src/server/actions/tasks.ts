"use server";

import { auth } from "@clerk/nextjs/server";
import {
  listOpenTasks,
  getTaskById,
  claimTask as dbClaimTask,
  submitTaskProof as dbSubmitTaskProof,
  getMyClaimedTasks,
} from "@/lib/db";
import { serialize } from "@/lib/firebase";

export async function getOpenTasks() {
  const tasks = await listOpenTasks();
  return serialize(tasks);
}

export async function fetchTaskById(taskId: string) {
  const task = await getTaskById(taskId);
  return task ? serialize(task) : null;
}

export async function fetchMyClaimedTasks() {
  const { userId } = await auth();
  if (!userId) return [];
  const tasks = await getMyClaimedTasks(userId);
  return serialize(tasks);
}

export async function claimTaskAction(taskId: string) {
  const { userId } = await auth();
  if (!userId) return { success: false, error: "Not authenticated" };
  return dbClaimTask(taskId, userId);
}

export async function submitProofAction(taskId: string, proofUrl: string, proofText: string) {
  const { userId } = await auth();
  if (!userId) return { success: false, error: "Not authenticated" };
  return dbSubmitTaskProof(taskId, userId, proofUrl, proofText);
}
