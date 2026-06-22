import { subscribe } from "@/app/actions";

const ERRORS: Record<string, string> = {
  invalid: "That doesn't look like a valid email — mind checking it?",
  config: "Signups are briefly unavailable. Please try again soon.",
  error: "Something went wrong on our end. Please try again.",
};

/**
 * Email capture (updates + early access to the hosted lab). Plain `<form>` posting
 * to the `subscribe` server action — no client JS. `status` comes from the page's
 * `searchParams` after the action redirects back.
 */
export function WaitlistForm({ status }: { status?: string }) {
  if (status === "subscribed") {
    return (
      <div className="waitlist" id="waitlist">
        <p className="waitlist-done">
          <span className="waitlist-check" aria-hidden="true">
            ✓
          </span>
          You&rsquo;re on the list. We&rsquo;ll be in touch — no spam.
        </p>
      </div>
    );
  }

  // `status` is attacker-controlled (?waitlist=…); guard the lookup so inherited
  // keys like `toString`/`__proto__` can't resolve to a function/object that
  // React then refuses to render.
  const error = status && Object.hasOwn(ERRORS, status) ? ERRORS[status] : null;

  return (
    <div className="waitlist" id="waitlist">
      <form className="waitlist-form" action={subscribe}>
        <input
          type="email"
          name="email"
          required
          autoComplete="email"
          placeholder="you@example.com"
          aria-label="Email address"
          aria-invalid={status === "invalid" ? true : undefined}
        />
        <button type="submit" className="btn btn-primary">
          Get updates
        </button>
      </form>
      {error ? (
        <p className="waitlist-error" role="alert">
          {error}
        </p>
      ) : (
        <p className="waitlist-note">
          Releases + early access to the hosted lab. No spam, unsubscribe anytime.
        </p>
      )}
    </div>
  );
}
