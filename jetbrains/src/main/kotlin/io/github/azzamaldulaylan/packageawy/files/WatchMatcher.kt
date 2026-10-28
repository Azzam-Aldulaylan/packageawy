package io.github.azzamaldulaylan.packageawy.files

import java.nio.file.Path

/** Decides whether a changed path belongs to a `files/watch` registration. */
class WatchMatcher(baseDir: String, glob: String) {
    val base: Path = Path.of(baseDir).toAbsolutePath().normalize()
    private val pattern = Glob(glob)

    fun matches(changedPath: String): Boolean {
        val path = runCatching { Path.of(changedPath).toAbsolutePath().normalize() }.getOrNull() ?: return false
        if (path == base || !path.startsWith(base)) return false
        return pattern.matches(FileFinder.relative(base, path))
    }
}
