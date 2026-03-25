import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  addDoc,
  query,
  where,
  orderBy,
  limit,
  Timestamp,
  increment,
  runTransaction,
} from "firebase/firestore";
import { db } from "./firebase";
import type {
  User,
  Campaign,
  CampaignTask,
  CampaignStatus,
  CreditTransaction,
  TaskType,
  TaskStatus,
} from "./types";
import { CREDIT_VALUES, TASK_INSTRUCTIONS, MAX_CLAIMED_TASKS, SIGNUP_BONUS_CREDITS } from "./types";

// ---- Users ----

export async function getUserByClerkId(clerkUserId: string): Promise<User | null> {
  const q = query(collection(db, "users"), where("clerkUserId", "==", clerkUserId), limit(1));
  const snap = await getDocs(q);
  if (snap.empty) return null;
  const d = snap.docs[0];
  return { id: d.id, ...d.data() } as User;
}

export async function createOrUpdateProfile(
  clerkUserId: string,
  email: string,
  data: { name: string; xHandle: string; bio: string; interests: string[] }
) {
  const existing = await getUserByClerkId(clerkUserId);
  if (existing) {
    const ref = doc(db, "users", existing.id);
    await updateDoc(ref, { ...data, updatedAt: Timestamp.now() });
    return existing.id;
  }
  const ref = await addDoc(collection(db, "users"), {
    clerkUserId,
    email,
    ...data,
    username: data.xHandle,
    credits: SIGNUP_BONUS_CREDITS,
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
  });

  // Record the signup bonus transaction
  await addDoc(collection(db, "creditTransactions"), {
    userId: clerkUserId,
    type: "earned",
    amount: SIGNUP_BONUS_CREDITS,
    sourceType: "signup_bonus",
    sourceId: ref.id,
    description: `Welcome bonus: ${SIGNUP_BONUS_CREDITS} credits`,
    createdAt: Timestamp.now(),
  });

  return ref.id;
}

// ---- Tasks ----

export async function listOpenTasks(): Promise<CampaignTask[]> {
  const q = query(
    collection(db, "campaignTasks"),
    where("status", "==", "open"),
    orderBy("createdAt", "desc")
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as CampaignTask);
}

export async function getTaskById(taskId: string): Promise<CampaignTask | null> {
  const ref = doc(db, "campaignTasks", taskId);
  const snap = await getDoc(ref);
  if (!snap.exists()) return null;
  return { id: snap.id, ...snap.data() } as CampaignTask;
}

export async function getClaimedTasksCount(userId: string): Promise<number> {
  const q = query(
    collection(db, "campaignTasks"),
    where("claimedByUserId", "==", userId),
    where("status", "==", "claimed")
  );
  const snap = await getDocs(q);
  return snap.size;
}

export async function getMyClaimedTasks(userId: string): Promise<CampaignTask[]> {
  const q = query(
    collection(db, "campaignTasks"),
    where("claimedByUserId", "==", userId),
    where("status", "in", ["claimed", "submitted"]),
    orderBy("claimedAt", "desc")
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as CampaignTask);
}

export async function claimTask(taskId: string, userId: string): Promise<{ success: boolean; error?: string }> {
  const task = await getTaskById(taskId);
  if (!task) return { success: false, error: "Task not found" };
  if (task.status !== "open") return { success: false, error: "Task is not available" };
  if (task.ownerUserId === userId) return { success: false, error: "Cannot claim your own task" };

  const claimedCount = await getClaimedTasksCount(userId);
  if (claimedCount >= MAX_CLAIMED_TASKS) {
    return { success: false, error: `You can only have ${MAX_CLAIMED_TASKS} claimed tasks at a time` };
  }

  const ref = doc(db, "campaignTasks", taskId);
  await updateDoc(ref, {
    status: "claimed",
    claimedByUserId: userId,
    claimedAt: Timestamp.now(),
  });
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
    const q = query(
      collection(db, "campaignTasks"),
      where("proofUrl", "==", proofUrl),
      where("status", "in", ["submitted", "approved"])
    );
    const snap = await getDocs(q);
    if (!snap.empty) {
      return { success: false, error: "This proof URL has already been submitted" };
    }
  }

  const ref = doc(db, "campaignTasks", taskId);
  await updateDoc(ref, {
    status: "submitted",
    proofUrl: proofUrl || null,
    proofText: proofText || null,
    submittedAt: Timestamp.now(),
  });
  return { success: true };
}

// ---- Task Review (by campaign owner) ----

export async function listPendingSubmissionsForOwner(ownerUserId: string): Promise<CampaignTask[]> {
  const q = query(
    collection(db, "campaignTasks"),
    where("ownerUserId", "==", ownerUserId),
    where("status", "==", "submitted"),
    orderBy("submittedAt", "asc")
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as CampaignTask);
}

async function addCreditsToUser(userId: string, amount: number) {
  const userQuery = query(
    collection(db, "users"),
    where("clerkUserId", "==", userId),
    limit(1)
  );
  const snap = await getDocs(userQuery);
  if (snap.empty) {
    const userRef = doc(db, "users", userId);
    const userSnap = await getDoc(userRef);
    if (userSnap.exists()) {
      await updateDoc(userRef, { credits: increment(amount) });
    }
  } else {
    await updateDoc(doc(db, "users", snap.docs[0].id), {
      credits: increment(amount),
    });
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

  const taskRef = doc(db, "campaignTasks", taskId);
  await updateDoc(taskRef, {
    status: "approved",
    reviewedAt: Timestamp.now(),
    reviewedByUserId: reviewerUserId,
  });

  // Award credits to the user who completed the task
  await addCreditsToUser(task.claimedByUserId!, task.creditReward);

  await addDoc(collection(db, "creditTransactions"), {
    userId: task.claimedByUserId,
    type: "earned",
    amount: task.creditReward,
    sourceType: "task_approval",
    sourceId: taskId,
    description: `Earned ${task.creditReward} credits for completing ${task.type} task`,
    createdAt: Timestamp.now(),
  });

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

  const ref = doc(db, "campaignTasks", taskId);
  await updateDoc(ref, {
    status: "rejected",
    reviewedAt: Timestamp.now(),
    reviewedByUserId: reviewerUserId,
    ...(reason ? { rejectionReason: reason } : {}),
  });
  return { success: true };
}

// ---- Campaigns ----

export async function listMyCampaigns(userId: string): Promise<Campaign[]> {
  const q = query(
    collection(db, "campaigns"),
    where("ownerUserId", "==", userId),
    orderBy("createdAt", "desc")
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Campaign);
}

export async function getCampaignById(campaignId: string): Promise<Campaign | null> {
  const ref = doc(db, "campaigns", campaignId);
  const snap = await getDoc(ref);
  if (!snap.exists()) return null;
  return { id: snap.id, ...snap.data() } as Campaign;
}

export async function getCampaignTaskStats(campaignId: string) {
  const q = query(collection(db, "campaignTasks"), where("campaignId", "==", campaignId));
  const snap = await getDocs(q);
  const tasks = snap.docs.map((d) => d.data());
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

  const ref = doc(db, "campaigns", campaignId);
  await updateDoc(ref, {
    title: data.title,
    description: data.description,
    targetUrl: data.targetUrl,
    topics: data.topics,
    status: data.status,
    updatedAt: Timestamp.now(),
  });

  // Also update targetUrl on all open tasks if it changed
  if (data.targetUrl !== campaign.targetUrl) {
    const tasksQ = query(
      collection(db, "campaignTasks"),
      where("campaignId", "==", campaignId),
      where("status", "==", "open")
    );
    const snap = await getDocs(tasksQ);
    for (const d of snap.docs) {
      await updateDoc(doc(db, "campaignTasks", d.id), { targetUrl: data.targetUrl });
    }
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
  const inProgressQ = query(
    collection(db, "campaignTasks"),
    where("campaignId", "==", campaignId),
    where("status", "in", ["claimed", "submitted"])
  );
  const inProgressSnap = await getDocs(inProgressQ);
  if (!inProgressSnap.empty) {
    return { success: false, error: "Cannot delete: campaign has claimed or submitted tasks" };
  }

  // Delete all open tasks
  const openTasksQ = query(
    collection(db, "campaignTasks"),
    where("campaignId", "==", campaignId),
    where("status", "==", "open")
  );
  const openSnap = await getDocs(openTasksQ);
  for (const d of openSnap.docs) {
    await deleteDoc(doc(db, "campaignTasks", d.id));
  }

  // Refund remaining credits to the owner
  if (campaign.remainingCredits > 0) {
    await addCreditsToUser(userId, campaign.remainingCredits);
    await addDoc(collection(db, "creditTransactions"), {
      userId,
      type: "refund",
      amount: campaign.remainingCredits,
      sourceType: "campaign_creation",
      sourceId: campaignId,
      description: `Refunded ${campaign.remainingCredits} credits from deleted campaign: ${campaign.title}`,
      createdAt: Timestamp.now(),
    });
  }

  // Delete the campaign document
  await deleteDoc(doc(db, "campaigns", campaignId));

  return { success: true };
}

// ---- Account Deletion (cascade) ----

export async function deleteAllUserData(clerkUserId: string): Promise<void> {
  // 1. Find the user document
  const userQ = query(collection(db, "users"), where("clerkUserId", "==", clerkUserId), limit(1));
  const userSnap = await getDocs(userQ);

  // 2. Delete all campaigns owned by this user and their tasks
  const campaignsQ = query(collection(db, "campaigns"), where("ownerUserId", "==", clerkUserId));
  const campaignsSnap = await getDocs(campaignsQ);
  for (const campaignDoc of campaignsSnap.docs) {
    // Delete all tasks for this campaign
    const tasksQ = query(collection(db, "campaignTasks"), where("campaignId", "==", campaignDoc.id));
    const tasksSnap = await getDocs(tasksQ);
    for (const taskDoc of tasksSnap.docs) {
      await deleteDoc(doc(db, "campaignTasks", taskDoc.id));
    }
    await deleteDoc(doc(db, "campaigns", campaignDoc.id));
  }

  // 3. Delete tasks claimed by this user (release them back or delete)
  const claimedTasksQ = query(
    collection(db, "campaignTasks"),
    where("claimedByUserId", "==", clerkUserId)
  );
  const claimedSnap = await getDocs(claimedTasksQ);
  for (const taskDoc of claimedSnap.docs) {
    const taskData = taskDoc.data();
    if (taskData.status === "claimed" || taskData.status === "submitted") {
      // Release back to open so others can claim
      await updateDoc(doc(db, "campaignTasks", taskDoc.id), {
        status: "open",
        claimedByUserId: null,
        claimedAt: null,
        submittedAt: null,
        proofUrl: null,
        proofText: null,
      });
    }
  }

  // 4. Delete all credit transactions for this user
  const txQ = query(collection(db, "creditTransactions"), where("userId", "==", clerkUserId));
  const txSnap = await getDocs(txQ);
  for (const txDoc of txSnap.docs) {
    await deleteDoc(doc(db, "creditTransactions", txDoc.id));
  }

  // 5. Delete the user document
  if (!userSnap.empty) {
    await deleteDoc(doc(db, "users", userSnap.docs[0].id));
  }
}

// ---- Campaigns ----

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
  const userQ = query(collection(db, "users"), where("clerkUserId", "==", userId), limit(1));
  let userSnap = await getDocs(userQ);
  let userDocId: string;
  let userData: Record<string, unknown>;

  if (userSnap.empty) {
    // Try by doc id
    const userRef = doc(db, "users", userId);
    const uSnap = await getDoc(userRef);
    if (!uSnap.exists()) return { success: false, error: "User not found" };
    userDocId = uSnap.id;
    userData = uSnap.data();
  } else {
    userDocId = userSnap.docs[0].id;
    userData = userSnap.docs[0].data();
  }

  if ((userData.credits as number) < totalCost) {
    return { success: false, error: `Not enough credits. Need ${totalCost}, have ${userData.credits}` };
  }

  // Deduct credits
  await updateDoc(doc(db, "users", userDocId), {
    credits: increment(-totalCost),
  });

  // Create campaign
  const campaignRef = await addDoc(collection(db, "campaigns"), {
    ownerUserId: userId,
    title: data.title,
    description: data.description,
    targetUrl: data.targetUrl,
    topics: data.topics,
    status: "active",
    budgetCredits: totalCost,
    remainingCredits: totalCost,
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
  });

  // Generate tasks
  const taskTypes: { type: TaskType; count: number }[] = [
    { type: "like", count: data.likeCount },
    { type: "reply", count: data.replyCount },
    { type: "quote", count: data.quoteCount },
  ];

  for (const { type, count } of taskTypes) {
    for (let i = 0; i < count; i++) {
      await addDoc(collection(db, "campaignTasks"), {
        campaignId: campaignRef.id,
        ownerUserId: userId,
        type,
        instructions: TASK_INSTRUCTIONS[type],
        targetUrl: data.targetUrl,
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
    }
  }

  // Create credit transaction
  await addDoc(collection(db, "creditTransactions"), {
    userId,
    type: "spent",
    amount: totalCost,
    sourceType: "campaign_creation",
    sourceId: campaignRef.id,
    description: `Spent ${totalCost} credits to create campaign: ${data.title}`,
    createdAt: Timestamp.now(),
  });

  return { success: true, campaignId: campaignRef.id };
}

