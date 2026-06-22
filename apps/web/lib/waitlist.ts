import "server-only";

/**
 * Buttondown email capture. Called only from the `subscribe` server action, so
 * the API key never reaches the client. The list is a single "updates + early
 * access" list (no segmentation at v1 — tag in Buttondown later if needed).
 */

const ENDPOINT = "https://api.buttondown.com/v1/subscribers";

export type SubscribeReason = "invalid" | "config" | "error";
export type SubscribeResult = { ok: true } | { ok: false; reason: SubscribeReason };

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export async function subscribeToButtondown(
  email: string,
  apiKey: string | undefined = process.env.BUTTONDOWN_API_KEY,
  fetchImpl: typeof fetch = fetch,
): Promise<SubscribeResult> {
  const trimmed = email.trim();
  if (!isValidEmail(trimmed)) return { ok: false, reason: "invalid" };
  if (!apiKey) return { ok: false, reason: "config" };

  let res: Response;
  try {
    res = await fetchImpl(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Token ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email_address: trimmed, tags: ["landing-page"] }),
    });
  } catch {
    return { ok: false, reason: "error" };
  }

  if (res.ok) return { ok: true };

  // Already-subscribed comes back as 400/409 with a JSON `code` of
  // `email_already_exists`; treat it as success (idempotent). Fall back to a
  // substring match in case the error envelope changes.
  if (res.status === 400 || res.status === 409) {
    const body = await res.text().catch(() => "");
    let code = "";
    try {
      code = JSON.parse(body)?.code ?? "";
    } catch {
      // body wasn't JSON; fall through to the substring check
    }
    if (code === "email_already_exists" || /already|exists|duplicate|subscribed/i.test(body)) {
      return { ok: true };
    }
  }
  return { ok: false, reason: "error" };
}
