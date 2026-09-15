/**
 * Input validation for anything that reaches pnpm or the filesystem.
 *
 * Both the kernel installer and the plugin manager take strings that originate
 * outside the process — a registry response, or a renderer's IPC payload — and
 * turn them into (a) a pnpm argument and (b) a path component. Either one is
 * an injection point:
 *
 *   - A name beginning with `-` is parsed by pnpm as a flag, not a package.
 *   - A version containing `..` or a separator escapes the snapshots directory
 *     when joined into a path.
 *
 * The registry is trusted only as far as "it answered 200"; a mirror can be
 * misconfigured or hostile, so even remote metadata goes through here.
 */

/** npm package name: optional scope, then the name itself. */
const PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i

/**
 * Semver with an optional leading `=` / `v` and an optional prerelease or
 * build suffix. Deliberately stricter than the spec: we only ever install a
 * single exact version, not a range.
 */
const VERSION_RE = /^v?=?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/

const DIST_TAG_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/i

class ValidationError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ValidationError'
    this.code = code
  }
}

/** Validate an npm package name: `@scope/name` or `name`. */
function assertPackageName(name) {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new ValidationError('NAME_REQUIRED', '缺少包名')
  }
  const value = name.trim()
  if (value.length > 214 || !PACKAGE_NAME_RE.test(value)) {
    throw new ValidationError('NAME_INVALID', `非法包名：${value}`)
  }
  return value
}

/**
 * Validate a version string used as a directory name and a pnpm spec.
 * `latest` (and any dist-tag) is allowed only where explicitly permitted,
 * because it cannot be used as a path.
 */
function assertVersion(version, { allowTag = false } = {}) {
  if (typeof version !== 'string' || version.trim() === '') {
    throw new ValidationError('VERSION_REQUIRED', '缺少版本号')
  }
  const value = version.trim()
  if (VERSION_RE.test(value)) return value.replace(/^[v=]/, '')
  if (allowTag && DIST_TAG_RE.test(value)) return value
  throw new ValidationError(
    'VERSION_INVALID',
    `非法版本号：${value}（应为 x.y.z${allowTag ? ' 或 dist-tag' : ''}）`
  )
}

/** A resolved, path-safe version. Never accepts a dist-tag. */
function assertSnapshotVersion(version) {
  return assertVersion(version, { allowTag: false })
}

module.exports = {
  ValidationError,
  assertPackageName,
  assertVersion,
  assertSnapshotVersion,
  PACKAGE_NAME_RE,
  VERSION_RE
}
