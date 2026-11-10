package io.github.azzamaldulaylan.packageawy.ide

import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class OpenManifestTest {
    @Test
    fun `only files named package json show the action`() {
        assertTrue(OpenManifest.isPackageJson("package.json"))
        assertFalse(OpenManifest.isPackageJson("package-lock.json"))
        assertFalse(OpenManifest.isPackageJson("Package.json"))
    }

    @Test
    fun `project and workspace member manifests are eligible`() {
        assertTrue(OpenManifest.isEligible("/repo/package.json"))
        assertTrue(OpenManifest.isEligible("/repo/packages/app/package.json"))
        assertTrue(OpenManifest.isEligible("C:\\repo\\packages\\app\\package.json"))
    }

    @Test
    fun `manifests inside node_modules are not eligible`() {
        assertFalse(OpenManifest.isEligible("/repo/node_modules/react/package.json"))
        assertFalse(OpenManifest.isEligible("C:\\repo\\node_modules\\@scope\\pkg\\package.json"))
        assertFalse(OpenManifest.isEligible("/repo/tsconfig.json"))
    }
}
