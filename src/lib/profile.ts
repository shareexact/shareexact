const KEY = "shareexact:profile";

export interface DeskProfile {
  name: string;
  handle: string;
  motto: string;
}

export const DEFAULT_PROFILE: DeskProfile = {
  name: "",
  handle: "",
  motto: "",
};

export function loadProfile(): DeskProfile {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_PROFILE };
    const parsed = JSON.parse(raw) as Partial<DeskProfile>;
    return {
      name: String(parsed.name ?? "").slice(0, 40),
      handle: String(parsed.handle ?? "").slice(0, 24),
      motto: String(parsed.motto ?? "").slice(0, 80),
    };
  } catch {
    return { ...DEFAULT_PROFILE };
  }
}

export function saveProfile(profile: DeskProfile) {
  const next: DeskProfile = {
    name: profile.name.trim().slice(0, 40),
    handle: profile.handle.trim().replace(/^@/, "").slice(0, 24),
    motto: profile.motto.trim().slice(0, 80),
  };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* private mode */
  }
  return next;
}

export function profileInitial(profile: DeskProfile) {
  const src = profile.name || profile.handle || "S";
  return src.slice(0, 1).toUpperCase();
}
