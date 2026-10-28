package io.github.azzamaldulaylan.packageawy.files

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.CancellationException

class FileFinderTest {
    @TempDir
    lateinit var root: Path

    private fun touch(rel: String) {
        val file = root.resolve(rel)
        Files.createDirectories(file.parent)
        Files.writeString(file, "{}")
    }

    private fun rel(paths: List<String>) = paths.map { root.relativize(Path.of(it)).joinToString("/") }.sorted()

    private val exclude = "**/{node_modules,.git,dist}/**"

    @Test
    fun `finds manifests and skips excluded directories`() {
        listOf("package.json", "packages/a/package.json", "node_modules/x/package.json", "packages/a/node_modules/y/package.json", "dist/package.json")
            .forEach(::touch)
        val found = FileFinder.find(root, "", "**/package.json", exclude, null)
        assertEquals(listOf("package.json", "packages/a/package.json"), rel(found))
        assertTrue(found.all { Path.of(it).isAbsolute })
    }

    @Test
    fun `include is relative to dir and exclude to the folder`() {
        listOf("packages/a/src/x.ts", "packages/a/dist/y.ts", "packages/b/src/z.ts").forEach(::touch)
        val found = FileFinder.find(root, "packages/a", "**/*.{ts,js}", exclude, null)
        assertEquals(listOf("packages/a/src/x.ts"), rel(found))
    }

    @Test
    fun `respects max results`() {
        (1..10).forEach { touch("f$it.ts") }
        assertEquals(3, FileFinder.find(root, "", "*.ts", "", 3).size)
    }

    @Test
    fun `missing dir finds nothing`() {
        assertTrue(FileFinder.find(root, "missing", "**", "", null).isEmpty())
    }

    @Test
    fun `cancellation stops the walk`() {
        touch("a/b/c.ts")
        assertThrows<CancellationException> { FileFinder.find(root, "", "**", "", null) { true } }
    }

    @Test
    fun `watch matcher matches relative to its base`() {
        val matcher = WatchMatcher(root.resolve("pkg").toString(), "{package-lock.json,pnpm-lock.yaml}")
        assertTrue(matcher.matches(root.resolve("pkg/pnpm-lock.yaml").toString()))
        assertFalse(matcher.matches(root.resolve("pkg/sub/pnpm-lock.yaml").toString()))
        assertFalse(matcher.matches(root.resolve("other/pnpm-lock.yaml").toString()))
        assertFalse(matcher.matches(root.resolve("pkg").toString()))
    }
}
