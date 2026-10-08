export function configuredApplicationOrigin(
  request: Request,
  configuredOrigin: string | undefined,
  allowLocalHttp: boolean
): string | undefined {
  if (!configuredOrigin) return undefined;
  try {
    const expected = new URL(configuredOrigin);
    if (
      (!allowLocalHttp && expected.protocol !== "https:") ||
      (allowLocalHttp && expected.protocol !== "https:" && expected.protocol !== "http:") ||
      expected.username ||
      expected.password ||
      expected.pathname !== "/" ||
      expected.search ||
      expected.hash
    ) {
      return undefined;
    }
    if (!requestHostMatches(request, expected.origin)) return undefined;
    return expected.origin;
  } catch {
    return undefined;
  }
}

export function requestHostMatches(request: Request, expectedOrigin: string): boolean {
  try {
    const expected = new URL(expectedOrigin);
    const requestUrl = new URL(request.url);
    const host = request.headers.get("Host");
    return (
      requestUrl.origin === expected.origin &&
      requestUrl.host.toLowerCase() === expected.host.toLowerCase() &&
      (host === null || host.toLowerCase() === expected.host.toLowerCase())
    );
  } catch {
    return false;
  }
}

export function requestOriginMatches(
  request: Request,
  expectedOrigin: string,
  originRequired: boolean
): boolean {
  const origin = request.headers.get("Origin");
  if (originRequired && origin === null) return false;
  return origin === null || origin === expectedOrigin;
}
