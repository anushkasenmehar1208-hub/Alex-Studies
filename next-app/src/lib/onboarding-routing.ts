export type EntryMemory = {
  is_started?: boolean;
  degree?: string | null;
  selected_year?: string | null;
  selected_semester?: string | null;
} | null;

export function appUrlForScope(scope: string): string {
  return `/app?onboarded=1&scope=${encodeURIComponent(scope)}`;
}

export type OnboardingEntry =
  | { action: "form" }
  | { action: "login" }
  | { action: "app"; to: string };

export function decideOnboardingEntry(input: {
  status: number;
  hasAuth: boolean;
  memory: EntryMemory;
}): OnboardingEntry {
  if (input.status === 401) {
    // A signed-in browser whose session died keeps the login hop.
    if (input.hasAuth) return { action: "login" };
    return { action: "form" };
  }
  const memory = input.memory;
  if (
    input.status === 200 &&
    memory &&
    memory.is_started &&
    memory.degree &&
    memory.selected_year &&
    memory.selected_semester
  ) {
    // Resume only server-confirmed completion, never a local scope hint.
    return { action: "app", to: input.hasAuth ? "/app" : appUrlForScope(`y${memory.selected_year.match(/\d+/)?.[0]}s${memory.selected_semester.match(/\d+/)?.[0]}`) };
  }
  // Not onboarded yet, or the status check failed — show the form.
  return { action: "form" };
}

export function decideOnboardingFinish(input: {
  status: number;
  hasAuth: boolean;
  scope: string;
}): { action: "continue"; to: string } | { action: "error" } {
  if (input.status === 200) {
    return { action: "continue", to: appUrlForScope(input.scope) };
  }
  return { action: "error" };
}

