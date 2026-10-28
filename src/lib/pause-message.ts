// What a customer reads when their workspace is paused.
//
// `accounts.paused_reason` is the operator's record: the numbers, the rule
// that fired, and for the fraud checks the evidence (a repeat pause names the
// OTHER workspace it matched, which must never reach this tenant). So the
// banner is built from it rather than printing it. Most customers who land
// here made an honest mistake with a list, and the first thing they read
// should say so, explain what the pause protects (their own domain), and
// tell them a person will help. See mrr/outreach/SUPPORT-VOICE.md.

export const SUPPORT_EMAIL = "connect@day3.app";

// The reasons health.ts writes. They carry the customer's own numbers, which
// are worth showing: "4.2% bounced" explains the pause better than any policy.
const REPUTATION_REASON = /bounce rate|complaint rate|rejected .* as spam|campaigns were paused for/i;

export function customerPauseMessage(pausedReason: string | null | undefined): string {
  const reason = pausedReason?.trim();

  if (reason && REPUTATION_REASON.test(reason)) {
    return (
      `${reason.replace(/\.$/, "")}. ` +
      "That usually means part of the list is old or did not sign up to hear from you, and it happens to honest senders too. " +
      "I paused sending to protect your domain: inbox providers that see numbers like this start sending all of your mail to spam, even the important emails. " +
      "Every address that bounced or complained is already removed. " +
      `Write to me at ${SUPPORT_EMAIL} and we will get you sending again together.`
    );
  }

  // The automated fraud checks (content-review.ts, repeat-fraud.ts) prefix
  // their record with "Automated:". Their evidence stays internal: an honest
  // customer caught by mistake gets a person, and an attacker learns nothing.
  if (!reason || reason.startsWith("Automated:")) {
    return (
      "I have paused sending while I take a look at your workspace. Nothing you sent is lost. " +
      `This is usually quick: write to me at ${SUPPORT_EMAIL} and I will get back to you.`
    );
  }

  // Typed by an operator for this customer, so it is already meant for them.
  return `${reason} Questions? Write to me at ${SUPPORT_EMAIL}.`;
}
