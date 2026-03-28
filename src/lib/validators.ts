import { z } from "zod/v4";

export const profileSchema = z.object({
  name: z.string().min(1, "Name is required"),
  xHandle: z.string().min(1, "X handle is required"),
});

export type ProfileInput = z.infer<typeof profileSchema>;

export const campaignSchema = z.object({
  title: z.string().min(1, "Title is required"),
  description: z.string().min(1, "Description is required"),
  targetUrl: z.string().url("Must be a valid URL"),
  topics: z.string().optional().default(""),
  likeCount: z.coerce.number().int().min(0).default(0),
  replyCount: z.coerce.number().int().min(0).default(0),
  quoteCount: z.coerce.number().int().min(0).default(0),
});

export type CampaignInput = z.infer<typeof campaignSchema>;

export const campaignEditSchema = z.object({
  title: z.string().min(1, "Title is required"),
  description: z.string().min(1, "Description is required"),
  targetUrl: z.string().url("Must be a valid URL"),
  topics: z.string().optional().default(""),
  status: z.enum(["draft", "active", "paused", "completed"]),
});

export type CampaignEditInput = z.infer<typeof campaignEditSchema>;
