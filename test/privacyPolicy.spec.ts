import { describe, expect, it } from "vitest";
import { getPrivacyPolicyResponse } from "../src/httpRouting/privacyPolicy";

describe("privacy policy", () => {
	it("returns a cacheable HTML document with current OneSignal disclosures", async () => {
		const response = getPrivacyPolicyResponse();
		const html = await response.text();

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe(
			"text/html; charset=UTF-8",
		);
		expect(response.headers.get("cache-control")).toBe(
			"no-cache, must-revalidate",
		);
		expect(html).toContain("Last updated: June 20, 2026");
		expect(html).toContain("Push Notifications and OneSignal");
		expect(html).toContain("https://onesignal.com/privacy_policy");
		expect(html).toContain("turn notifications off");
		expect(html).toContain(
			"This Privacy Policy has been created with the help of the",
		);
		expect(html).toContain("Interpretation and Definitions");
		expect(html).toContain("Delete Your Personal Data");
		expect(html).toContain("color: #000000");
		expect(html).toContain(
			"To send push notifications about the Application when You choose to enable notifications.",
		);
	});

	it("limits the added provider-specific wording to OneSignal", async () => {
		const response = getPrivacyPolicyResponse();
		const html = await response.text();

		expect(html).toContain("Service Providers, including OneSignal");
		expect(html).not.toContain("Cloudflare");
		expect(html).not.toContain("The Movie Database");
		expect(html).not.toContain("YouTube and Google");
		expect(html).not.toContain("To manage Your Account");
		expect(html).not.toContain("For the performance of a contract");
		expect(html).not.toContain("telephone calls");
		expect(html).not.toContain("special offers");
		expect(html).not.toContain("With business partners");
		expect(html).not.toContain("With other users");
		expect(html).not.toContain("signing in to Your Account");
		expect(html).not.toContain("via email and/or");
	});
});
