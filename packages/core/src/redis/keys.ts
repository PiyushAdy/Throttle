/**
 * The single place key names are constructed (PLAN Phase 1).
 *
 * Shape: `throttle:<tier>:<resolver>:<identity>`
 *   e.g. throttle:anonymous:ip:203.0.113.7
 *        throttle:apiKey:apikey:9f86d081884c7d65...   ← SHA-256 of the key
 *
 * Note on hash tags: DECISIONS §3 sketches the key as `throttle:{<scope>:<key>}`,
 * but §11 explicitly rejects `{hash-tag}` slot-pinning — in Redis Cluster those
 * braces would force every key onto one slot and create a hot spot. Cluster is
 * out of scope, so the braces are dropped and unrelated keys hash freely.
 */
export const KEY_PREFIX = 'throttle';

export function buildKey(scope: string, identity: string): string {
  return `${KEY_PREFIX}:${scope}:${identity}`;
}

/** Scope prefix of a rule — tier plus resolver — before the identity is appended. */
export function ruleScope(tierName: string, resolverName: string): string {
  return `${tierName}:${resolverName}`;
}
