package io.github.azzamaldulaylan.packageawy.webview

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.awt.Color
import java.nio.file.Files
import java.nio.file.Path
import kotlin.io.path.extension
import kotlin.io.path.readText

class ThemeVariablesTest {
    private fun palette(dark: Boolean): Palette {
        val c = if (dark) Color(0x2B2D30) else Color(0xF7F8FA)
        val f = if (dark) Color(0xDFE1E5) else Color(0x000000)
        return Palette(
            dark, c, f, Color.GRAY, Color.DARK_GRAY, Color.BLUE, Color.LIGHT_GRAY, Color.CYAN, c, c, f, Color.GRAY,
            Color.GRAY, Color(0x3574F0), Color.WHITE, Color(0x3574F0), Color.BLUE, Color.BLUE, Color.RED, Color.PINK,
            Color.RED, Color.ORANGE, Color.YELLOW, Color.ORANGE, Color.BLUE, Color.CYAN, Color.BLUE, c,
            "Inter", 13, "JetBrains Mono",
        )
    }

    /** Every `--vscode-*` variable the webview reads, found the same way as `git grep` over webview/src. */
    private fun variablesUsedByWebview(): Set<String> {
        val src = Path.of(System.getProperty("user.dir")).resolve("../webview/src").normalize()
        val pattern = Regex("""var\(--vscode-([a-zA-Z0-9-]+)""")
        Files.walk(src).use { paths ->
            return paths.filter { it.extension in setOf("ts", "tsx", "css") }
                .flatMap { file -> pattern.findAll(file.readText()).map { it.groupValues[1] }.toList().stream() }
                .toList().toSet()
        }
    }

    @Test
    fun `defines every variable the webview uses`() {
        val used = variablesUsedByWebview()
        assertTrue(used.size > 20, "webview/src should use many --vscode variables")
        for (dark in listOf(true, false)) {
            val missing = used - ThemeVariables.from(palette(dark)).keys
            assertTrue(missing.isEmpty(), "Missing variables: $missing")
        }
    }

    @Test
    fun `formats colors for css`() {
        assertEquals("#3574f0", ThemeVariables.css(Color(0x3574F0)))
        assertEquals("rgba(1, 2, 3, 0.502)", ThemeVariables.css(Color(1, 2, 3, 128)))
    }

    @Test
    fun `font families are sanitized and have fallbacks`() {
        val vars = ThemeVariables.from(palette(true).copy(fontFamily = "Evil\"; } body{x:y", fontSizePx = 14))
        val family = vars.getValue("font-family")
        assertFalse(family.contains(";") || family.contains("}") || family.contains("{"))
        assertTrue(family.endsWith("sans-serif"))
        assertEquals("14px", vars["font-size"])
    }

    @Test
    fun `root rule sets the color scheme`() {
        val rule = ThemeVariables.rootRule(mapOf("foreground" to "#fff"), dark = true)
        assertEquals(":root{color-scheme:dark;--vscode-foreground:#fff;}", rule)
    }
}
