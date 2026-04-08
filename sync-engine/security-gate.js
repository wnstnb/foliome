function verifyDomain(actualUrl, expectedDomain) {
  try {
    const parsed = new URL(actualUrl);
    return parsed.hostname === expectedDomain;
  } catch {
    return false;
  }
}

function verifyHttps(actualUrl) {
  try {
    const parsed = new URL(actualUrl);
    return parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function runSecurityGate(actualUrl, config) {
  if (!actualUrl || typeof actualUrl !== 'string') {
    return { passed: false, reason: 'No URL provided' };
  }

  if (config.requireHttps !== false && !verifyHttps(actualUrl)) {
    return { passed: false, reason: `URL is not HTTPS: ${actualUrl}` };
  }

  if (config.expectedDomain && !verifyDomain(actualUrl, config.expectedDomain)) {
    try {
      const parsed = new URL(actualUrl);
      return { passed: false, reason: `Domain mismatch: expected ${config.expectedDomain}, got ${parsed.hostname}` };
    } catch {
      return { passed: false, reason: `Invalid URL: ${actualUrl}` };
    }
  }

  return { passed: true };
}

module.exports = { verifyDomain, verifyHttps, runSecurityGate };
