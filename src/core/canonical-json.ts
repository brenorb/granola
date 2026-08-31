/** Stable JSON for hashes, commitments, and durable equality checks. */
export interface CanonicalJsonOptions {
  omitUndefinedObjectProperties?: boolean;
}

export function canonicalJson(
  value: unknown,
  options: CanonicalJsonOptions = {}
): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Canonical JSON does not allow non-finite numbers");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item, options)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().flatMap((key) => {
      const item = object[key];
      if (item === undefined) {
        if (options.omitUndefinedObjectProperties) return [];
        throw new Error("Canonical JSON does not allow undefined values");
      }
      return [`${JSON.stringify(key)}:${canonicalJson(item, options)}`];
    }).join(",")}}`;
  }
  throw new Error(`Canonical JSON does not allow ${typeof value}`);
}
