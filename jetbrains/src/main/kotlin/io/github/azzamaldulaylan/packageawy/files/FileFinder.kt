package io.github.azzamaldulaylan.packageawy.files

import java.io.IOException
import java.nio.file.FileVisitResult
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.SimpleFileVisitor
import java.nio.file.attribute.BasicFileAttributes
import java.util.concurrent.CancellationException

/**
 * `files/find` on the local file system. `include` is relative to
 * `folder/dir`. `exclude` is relative to the folder, like VS Code's findFiles.
 * Symbolic links to directories are not followed.
 */
object FileFinder {
    fun find(
        folderPath: Path,
        dir: String,
        include: String,
        exclude: String,
        maxResults: Int?,
        isCancelled: () -> Boolean = { false },
    ): List<String> {
        val base = if (dir.isEmpty()) folderPath else folderPath.resolve(dir)
        if (!Files.isDirectory(base)) return emptyList()
        val includeGlob = Glob(include)
        val excludeGlob = exclude.takeIf { it.isNotBlank() }?.let(::Glob)
        val results = ArrayList<String>()
        val limit = maxResults?.takeIf { it > 0 } ?: Int.MAX_VALUE

        Files.walkFileTree(base, object : SimpleFileVisitor<Path>() {
            override fun preVisitDirectory(path: Path, attrs: BasicFileAttributes): FileVisitResult {
                if (isCancelled()) throw CancellationException()
                if (path == base) return FileVisitResult.CONTINUE
                val rel = relative(folderPath, path)
                // A directory is pruned when everything under it is excluded.
                if (excludeGlob != null && (excludeGlob.matches(rel) || excludeGlob.matches("$rel/"))) {
                    return FileVisitResult.SKIP_SUBTREE
                }
                return FileVisitResult.CONTINUE
            }

            override fun visitFile(path: Path, attrs: BasicFileAttributes): FileVisitResult {
                if (!attrs.isRegularFile) return FileVisitResult.CONTINUE
                if (excludeGlob != null && excludeGlob.matches(relative(folderPath, path))) return FileVisitResult.CONTINUE
                if (!includeGlob.matches(relative(base, path))) return FileVisitResult.CONTINUE
                results.add(path.toAbsolutePath().toString())
                return if (results.size >= limit) FileVisitResult.TERMINATE else FileVisitResult.CONTINUE
            }

            override fun visitFileFailed(file: Path, exc: IOException): FileVisitResult = FileVisitResult.CONTINUE
        })
        return results
    }

    fun relative(root: Path, path: Path): String = root.relativize(path).joinToString("/")
}
