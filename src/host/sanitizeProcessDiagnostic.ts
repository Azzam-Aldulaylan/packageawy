import { homedir } from 'node:os';
import { stripVTControlCharacters } from 'node:util';

import { stripUrlCredentials } from '../core/cache/keys.js';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Match home paths as paths, including shell/environment spellings of the home. */
function redactHome(text: string): string {
  const home = homedir();
  const windows = /^[a-z]:[\\/]|^\\\\/i.test(home);
  const homePattern = home.split(windows ? /[\\/]/ : /\//).map(escapeRegExp).join(windows ? '[\\\\/]' : '/');
  const aliases = windows ? '%(?:USERPROFILE|HOMEDRIVE%%HOMEPATH|HOMEPATH)%' : '\\$(?:HOME\\b|\\{HOME\\})';
  return text.replace(new RegExp(`(?<![\\w~])(?:${homePattern}|${aliases}|~)(?=$|[\\\\/\\s"'<>:),;])`, windows ? 'gi' : 'g'), '<home>');
}

/** Sanitize complete process output before callers flatten or truncate it for display. */
export function sanitizeProcessDiagnostic(text: string, tempRoot: string): string {
  // Drop terminal string payloads, including OSC links and DCS commands, even
  // when unterminated. Then strip CSI, other escape sequences and bare controls.
  const plain = stripVTControlCharacters(text.replace(
    /(?:\u001b\]|\u009d)[\s\S]*?(?:\u0007|\u001b\\|\u009c|$)|(?:\u001b[PX^_]|[\u0090\u0098\u009e\u009f])[\s\S]*?(?:\u001b\\|\u009c|$)/g,
    ''
  ))
    .replace(/\u001b[ -/]*[0-~]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '');

  const redacted = plain
    .replace(/(?:\b[a-z][a-z\d+.-]{0,31}:)?\/\/[^\s<>"']+/gi, url => stripUrlCredentials(url).replace(/([?&](?:access_token|authToken|token)=)[^&#]*/gi, '$1[redacted]'))
    // Also cover scheme-relative URLs and malformed URLs the URL parser refuses.
    .replace(/(\/\/)[^/\s<>"'?#]*@/g, '$1[redacted]@')
    .replace(/(?<![\w@/.-])((?:proxy-)?authorization["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n,}]+)/gi, '$1[redacted]')
    // Keys with explicit auth semantics may carry opaque values. Anchor the
    // whole key, so a dependency such as @octokit/auth-token is not a key match.
    .replace(/(?<![\w@/.-])((?:_auth(?:Token)?|_password|(?:NODE|NPM|YARN_NPM)_AUTH_TOKEN|NPM_CONFIG__AUTH(?:TOKEN)?|npmAuth(?:Token|Ident))["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\]]+)/gi, '$1[redacted]')
    // Generic credential keys need a secret-shaped value; package versions
    // (including packages named password or token) are useful diagnostics.
    .replace(/(?<![\w@/.-])((?:password|token|secret|api[_-]?key)["']?\s*[:=]\s*["']?)(?:[a-f\d]{32,}|[a-z\d+/_-]{32,}={0,2})(?=$|[\s"',;}\]])/gi, '$1[redacted]')
    .replace(/\b(Bearer|Basic)\s+[a-z\d._~+/-]+=*/gi, '$1 [redacted]')
    .replace(/\b(?:npm_[a-z\d]{36}|gh[pousr]_[a-z\d]{36}|github_pat_[a-z\d_]{82}|glpat-[a-z\d_-]{20})(?![a-z\d_])/gi, '[redacted]')
    .replaceAll(tempRoot, '<temporary-project>');
  return redactHome(redacted);
}
