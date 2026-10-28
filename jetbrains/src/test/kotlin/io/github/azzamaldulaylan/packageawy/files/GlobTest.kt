package io.github.azzamaldulaylan.packageawy.files

import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class GlobTest {
    @Test
    fun `double star prefix matches at the root and below`() {
        val glob = Glob("**/package.json")
        assertTrue(glob.matches("package.json"))
        assertTrue(glob.matches("packages/a/package.json"))
        assertFalse(glob.matches("package.json5"))
        assertFalse(glob.matches("my-package.json"))
    }

    @Test
    fun `brace groups including nested ones`() {
        val glob = Glob("{**/*.{js,ts,tsx},.eslintrc*}")
        assertTrue(glob.matches("src/a.ts"))
        assertTrue(glob.matches("a.tsx"))
        assertTrue(glob.matches(".eslintrc.json"))
        assertFalse(glob.matches("src/.eslintrc"))
        assertFalse(glob.matches("a.css"))
    }

    @Test
    fun `lockfile watch glob`() {
        val glob = Glob("{package-lock.json,npm-shrinkwrap.json,pnpm-lock.yaml}")
        assertTrue(glob.matches("pnpm-lock.yaml"))
        assertFalse(glob.matches("sub/pnpm-lock.yaml"))
    }

    @Test
    fun `exclude glob for default directories`() {
        val glob = Glob("**/{node_modules,.git,dist}/**")
        assertTrue(glob.matches("node_modules/x/package.json"))
        assertTrue(glob.matches("packages/a/node_modules/b/index.js"))
        assertTrue(glob.matches("node_modules/"))
        assertFalse(glob.matches("src/node_modules.ts"))
    }

    @Test
    fun `single star stays inside one segment`() {
        val glob = Glob("*.json")
        assertTrue(glob.matches("a.json"))
        assertFalse(glob.matches("a/b.json"))
    }

    @Test
    fun `question mark, classes and regex characters`() {
        assertTrue(Glob("file?.[jt]s").matches("file1.ts"))
        assertFalse(Glob("file?.[!jt]s").matches("file1.ts"))
        assertTrue(Glob("a+b(c).txt").matches("a+b(c).txt"))
        assertFalse(Glob("a.txt").matches("abtxt"))
    }
}
