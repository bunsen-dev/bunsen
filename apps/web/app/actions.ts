"use server";

import { redirect } from "next/navigation";

import { subscribeToButtondown } from "@/lib/waitlist";

/**
 * Waitlist submit path — a Server Action, so the page ships zero client JS and
 * the Buttondown key stays server-side. On completion we redirect back to the
 * form with a status the page reads from `searchParams` to render success/error.
 */
export async function subscribe(formData: FormData) {
  const email = String(formData.get("email") ?? "");
  const result = await subscribeToButtondown(email);
  redirect(result.ok ? "/?waitlist=subscribed#waitlist" : `/?waitlist=${result.reason}#waitlist`);
}
