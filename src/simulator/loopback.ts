export class SimulatorError extends Error {
  override name = "SimulatorError";
}

// URL.hostname keeps the brackets of an IPv6 literal.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * The simulator only talks to an app on this machine: it must never send
 * webhooks to a real or remote system.
 */
export function assertLoopbackUrl(text: string): URL {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new SimulatorError(`Not a valid URL: ${text}`);
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    !LOOPBACK_HOSTS.has(url.hostname)
  ) {
    throw new SimulatorError(
      `Refusing ${url.origin}: the simulator only sends to 127.0.0.1, localhost or [::1]`,
    );
  }
  return url;
}
