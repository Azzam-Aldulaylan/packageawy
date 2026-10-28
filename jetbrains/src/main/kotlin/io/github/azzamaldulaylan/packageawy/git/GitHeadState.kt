package io.github.azzamaldulaylan.packageawy.git

import java.nio.file.Files
import java.nio.file.Path

/** Where a repository keeps HEAD (`gitDir`) and its refs (`commonDir`, which differs for linked worktrees). */
data class GitLocation(val gitDir: Path, val commonDir: Path) {
    /** True when a change to `path` can move HEAD. */
    fun affects(path: Path): Boolean {
        val p = path.toAbsolutePath().normalize()
        return p == gitDir.resolve("HEAD") ||
            p == commonDir.resolve("packed-refs") ||
            p.startsWith(commonDir.resolve("refs").resolve("heads"))
    }
}

/** Reads HEAD from the files in `.git` directly, without the Git plugin. */
object GitHeadState {

    /** The innermost repository containing `projectPath`, or null. */
    fun locate(projectPath: Path): GitLocation? {
        var dir: Path? = projectPath.toAbsolutePath().normalize()
        while (dir != null) {
            val dotGit = dir.resolve(".git")
            if (Files.isDirectory(dotGit) && Files.isRegularFile(dotGit.resolve("HEAD"))) {
                return GitLocation(dotGit, dotGit)
            }
            if (Files.isRegularFile(dotGit)) return fromGitFile(dotGit)
            dir = dir.parent
        }
        return null
    }

    /** Branch name and commit, or the detached commit. Null when HEAD cannot be read. */
    fun identity(location: GitLocation): String? {
        val head = readTrimmed(location.gitDir.resolve("HEAD")) ?: return null
        if (!head.startsWith("ref:")) return "detached:$head"
        val ref = head.removePrefix("ref:").trim()
        val commit = readTrimmed(location.commonDir.resolve(ref)) ?: packedRef(location.commonDir, ref) ?: ""
        return "$ref@$commit"
    }

    private fun fromGitFile(dotGit: Path): GitLocation? {
        val line = readTrimmed(dotGit) ?: return null
        if (!line.startsWith("gitdir:")) return null
        val gitDir = dotGit.parent.resolve(line.removePrefix("gitdir:").trim()).normalize()
        if (!Files.isRegularFile(gitDir.resolve("HEAD"))) return null
        val common = readTrimmed(gitDir.resolve("commondir"))?.let { gitDir.resolve(it).normalize() } ?: gitDir
        return GitLocation(gitDir, common)
    }

    private fun packedRef(commonDir: Path, ref: String): String? {
        val lines = runCatching { Files.readAllLines(commonDir.resolve("packed-refs")) }.getOrNull() ?: return null
        return lines.firstNotNullOfOrNull { line ->
            val parts = line.trim().split(' ')
            if (parts.size == 2 && parts[1] == ref) parts[0] else null
        }
    }

    private fun readTrimmed(path: Path): String? = runCatching { Files.readString(path).trim() }.getOrNull()
}
