import { describe, expect, it } from "vitest";
import { getPrivacyPolicyResponse } from "../src/httpRouting/privacyPolicy";

describe("privacy policy", () => {
	it("returns a cacheable HTML document with accurate OneSignal disclosures", async () => {
		const response = getPrivacyPolicyResponse();
		const html = await response.text();

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe(
			"text/html; charset=UTF-8",
		);
		expect(response.headers.get("cache-control")).toBe(
			"no-cache, must-revalidate",
		);
		expect(html).toContain("Last updated: June 21, 2026");
		expect(html).toContain("Push Notifications and OneSignal");
		expect(html).toContain("https://onesignal.com/privacy_policy");
		expect(html).toContain("turn notifications off");
		expect(html).toContain(
			"The Application does not require an account",
		);
		expect(html).toContain("Interpretation and Definitions");
		expect(html).toContain("Pseudonymous Technical Information");
		expect(html).toContain("color: #8b1e1e");
		expect(html).toContain(
			"does not ask any user, regardless of age, to provide direct identifiers",
		);
		expect(html).toContain(
			"Accordingly, We do not knowingly collect direct identifiers from children",
		);
		expect(html).not.toContain("App Store content rating");
		expect(html).toContain(
			"We do not use OneSignal for targeted advertising",
		);
	});

	it("does not claim broader personal-data collection than the app performs", async () => {
		const response = getPrivacyPolicyResponse();
		const html = await response.text();

		expect(html).toContain(
			"We do not ask You to provide direct identifiers",
		);
		expect(html).toContain(
			"We do not maintain user accounts or a Company database",
		);
		expect(html).not.toContain("Cloudflare");
		expect(html).not.toContain("The Movie Database");
		expect(html).not.toContain("YouTube and Google");
		expect(html).not.toContain(
			"We use Your Personal data to provide and improve the Service",
		);
		expect(html).not.toContain(
			"By using the Service, You agree to the collection",
		);
		expect(html).not.toContain("personally identifiable information");
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
