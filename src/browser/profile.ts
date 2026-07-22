const PROFILE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,31})$/;

export function profileFromLocation(href: string): string {
  const value = new URL(href).searchParams.get("wallet");
  const profile = value === null ? "default" : value;
  if (!PROFILE_PATTERN.test(profile)) {
    throw new Error("Invalid wallet profile: use 1–32 lowercase letters, numbers, or hyphens");
  }
  return profile;
}

export function storageNameForProfile(profile: string): string {
  if (!PROFILE_PATTERN.test(profile)) throw new Error("Invalid wallet profile");
  return `granola-wallet-${profile}`;
}
