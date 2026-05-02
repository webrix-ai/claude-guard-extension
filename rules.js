const DEFAULT_RULES = [
  { id: "default-get", pattern: "*", pagePattern: "*", method: "GET", action: "allow", type: "default", description: "Allow all GET requests" },
  { id: "default-head", pattern: "*", pagePattern: "*", method: "HEAD", action: "allow", type: "default", description: "Allow all HEAD requests" },
  { id: "default-options", pattern: "*", pagePattern: "*", method: "OPTIONS", action: "allow", type: "default", description: "Allow all OPTIONS requests" },
  { id: "default-post", pattern: "*", pagePattern: "*", method: "POST", action: "block", type: "default", description: "Block all POST requests" },
  { id: "default-put", pattern: "*", pagePattern: "*", method: "PUT", action: "block", type: "default", description: "Block all PUT requests" },
  { id: "default-patch", pattern: "*", pagePattern: "*", method: "PATCH", action: "block", type: "default", description: "Block all PATCH requests" },
  { id: "default-delete", pattern: "*", pagePattern: "*", method: "DELETE", action: "block", type: "default", description: "Block all DELETE requests" },
];

function matchPattern(url, pattern) {
  if (!pattern || pattern === "*") return true;

  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  try {
    return new RegExp(`^${escaped}$`, "i").test(url);
  } catch {
    return false;
  }
}

function evaluateRequest(url, method, rules, pageUrl) {
  const customRules = rules.filter((r) => r.type === "custom");
  const defaultRules = rules.filter((r) => r.type === "default");

  for (const rule of customRules) {
    if (
      (rule.method === "*" || rule.method === method) &&
      matchPattern(url, rule.pattern) &&
      matchPattern(pageUrl, rule.pagePattern)
    ) {
      return { action: rule.action, rule };
    }
  }

  for (const rule of defaultRules) {
    if (
      (rule.method === "*" || rule.method === method) &&
      matchPattern(url, rule.pattern) &&
      matchPattern(pageUrl, rule.pagePattern)
    ) {
      return { action: rule.action, rule };
    }
  }

  return { action: "block", rule: null };
}

function extractDomainFromPattern(pattern) {
  if (!pattern || pattern === "*") return null;
  try {
    const u = new URL(pattern.replace(/\*/g, "placeholder"));
    return u.hostname.replace(/placeholder/g, "");
  } catch {}
  const domainMatch = pattern.match(/([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}/i);
  return domainMatch ? domainMatch[0] : null;
}

if (typeof globalThis !== "undefined") {
  globalThis.DEFAULT_RULES = DEFAULT_RULES;
  globalThis.matchPattern = matchPattern;
  globalThis.evaluateRequest = evaluateRequest;
  globalThis.extractDomainFromPattern = extractDomainFromPattern;
}
