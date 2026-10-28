import { describe, expect, it } from "vitest";
import { customerPauseMessage } from "@/lib/pause-message";

describe("customerPauseMessage", () => {
  it("shows a reputation pause with the customer's own numbers, warmly", () => {
    const msg = customerPauseMessage(
      "Complaint rate 0.350% exceeded 0.3% (5 complaints of 1430 sent in 14 days)",
    );
    expect(msg).toContain("5 complaints of 1430 sent");
    expect(msg).toMatch(/honest senders/);
    expect(msg).toMatch(/protect your domain/);
    expect(msg).toContain("connect@day3.app");
  });

  it("never shows a fraud check's evidence to the tenant", () => {
    const msg = customerPauseMessage(
      "Automated: repeat of a paused workspace, it paid with the same card (visa 4242) as paused workspace Evil Co (acc_x).",
    );
    expect(msg).not.toMatch(/Evil Co|4242|acc_x|repeat/);
    expect(msg).toContain("connect@day3.app");
  });

  it("passes an operator's own words through", () => {
    const msg = customerPauseMessage("I am checking your new domain, back within the hour.");
    expect(msg).toMatch(/^I am checking your new domain/);
  });

  it("has something human to say with no reason at all", () => {
    expect(customerPauseMessage(null)).toMatch(/Nothing you sent is lost/);
  });
});
