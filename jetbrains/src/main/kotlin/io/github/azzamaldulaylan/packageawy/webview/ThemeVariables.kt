package io.github.azzamaldulaylan.packageawy.webview

import java.awt.Color

/** The IDE colors and fonts the webview theme is built from. */
data class Palette(
    val dark: Boolean,
    val background: Color,
    val foreground: Color,
    val secondaryForeground: Color,
    val border: Color,
    val focus: Color,
    val hoverBackground: Color,
    val selectionBackground: Color,
    val popupBackground: Color,
    val inputBackground: Color,
    val inputForeground: Color,
    val inputBorder: Color,
    val placeholder: Color,
    val buttonBackground: Color,
    val buttonForeground: Color,
    val buttonBorder: Color,
    val link: Color,
    val linkHover: Color,
    val error: Color,
    val errorBackground: Color,
    val errorBorder: Color,
    val warning: Color,
    val warningBackground: Color,
    val warningBorder: Color,
    val info: Color,
    val infoBackground: Color,
    val infoBorder: Color,
    val codeBackground: Color,
    val fontFamily: String,
    val fontSizePx: Int,
    val editorFontFamily: String,
)

/** Maps a [Palette] to the `--vscode-*` custom properties the webview stylesheet reads. */
object ThemeVariables {

    fun from(p: Palette): Map<String, String> {
        val chart = if (p.dark) DARK_CHARTS else LIGHT_CHARTS
        val v = LinkedHashMap<String, String>()
        v["font-family"] = fontStack(p.fontFamily, SANS_FALLBACK)
        v["font-size"] = "${p.fontSizePx}px"
        v["editor-font-family"] = fontStack(p.editorFontFamily, MONO_FALLBACK)

        v["foreground"] = css(p.foreground)
        v["descriptionForeground"] = css(p.secondaryForeground)
        v["errorForeground"] = css(p.error)
        v["focusBorder"] = css(p.focus)
        v["editor-background"] = css(p.background)
        v["editor-foreground"] = css(p.foreground)
        v["sideBar-background"] = css(p.background)
        v["editorWidget-background"] = css(p.popupBackground)
        v["editorWidget-foreground"] = css(p.foreground)
        v["panel-border"] = css(p.border)
        v["widget-border"] = css(p.border)
        v["widget-shadow"] = if (p.dark) "rgba(0, 0, 0, 0.36)" else "rgba(0, 0, 0, 0.16)"

        v["button-background"] = css(p.buttonBackground)
        v["button-foreground"] = css(p.buttonForeground)
        v["button-border"] = css(p.buttonBorder)
        v["button-hoverBackground"] = css(shade(p.buttonBackground, p.dark))
        v["toolbar-hoverBackground"] = css(p.hoverBackground)
        v["list-hoverBackground"] = css(p.hoverBackground)
        v["badge-background"] = css(p.selectionBackground)
        v["badge-foreground"] = css(p.foreground)
        v["progressBar-background"] = css(p.focus)

        v["input-background"] = css(p.inputBackground)
        v["input-foreground"] = css(p.inputForeground)
        v["input-border"] = css(p.inputBorder)
        v["input-placeholderForeground"] = css(p.placeholder)
        v["dropdown-background"] = css(p.inputBackground)
        v["dropdown-foreground"] = css(p.inputForeground)
        v["dropdown-border"] = css(p.inputBorder)

        v["inputValidation-errorBackground"] = css(p.errorBackground)
        v["inputValidation-errorBorder"] = css(p.errorBorder)
        v["inputValidation-warningBackground"] = css(p.warningBackground)
        v["inputValidation-warningBorder"] = css(p.warningBorder)
        v["inputValidation-warningForeground"] = css(p.foreground)
        v["inputValidation-infoBackground"] = css(p.infoBackground)
        v["inputValidation-infoBorder"] = css(p.infoBorder)
        v["inputValidation-infoForeground"] = css(p.foreground)

        v["editorError-foreground"] = css(p.error)
        v["editorWarning-foreground"] = css(p.warning)
        v["editorInfo-foreground"] = css(p.info)

        v["textLink-foreground"] = css(p.link)
        v["textLink-activeForeground"] = css(p.linkHover)
        v["textPreformat-foreground"] = css(p.foreground)
        v["textCodeBlock-background"] = css(p.codeBackground)

        v["scrollbarSlider-background"] = css(withAlpha(p.foreground, 0.2))
        v["scrollbarSlider-hoverBackground"] = css(withAlpha(p.foreground, 0.35))

        for ((name, color) in chart) v["charts-$name"] = color
        return v
    }

    /** A `:root` rule declaring every variable. */
    fun rootRule(vars: Map<String, String>, dark: Boolean): String = buildString {
        append(":root{color-scheme:").append(if (dark) "dark" else "light").append(';')
        for ((name, value) in vars) append("--vscode-").append(name).append(':').append(value).append(';')
        append('}')
    }

    fun css(color: Color): String =
        if (color.alpha == 255) {
            "#%02x%02x%02x".format(color.red, color.green, color.blue)
        } else {
            "rgba(${color.red}, ${color.green}, ${color.blue}, ${"%.3f".format(java.util.Locale.ROOT, color.alpha / 255.0)})"
        }

    private fun withAlpha(color: Color, alpha: Double) = Color(color.red, color.green, color.blue, (alpha * 255).toInt())

    private fun shade(color: Color, dark: Boolean): Color {
        val factor = if (dark) 1.12 else 0.9
        fun channel(c: Int) = (c * factor).toInt().coerceIn(0, 255)
        return Color(channel(color.red), channel(color.green), channel(color.blue), color.alpha)
    }

    private fun fontStack(family: String, fallback: String): String {
        val safe = family.replace(Regex("[^A-Za-z0-9 ._-]"), "").trim()
        return if (safe.isEmpty()) fallback else "\"$safe\", $fallback"
    }

    private const val SANS_FALLBACK = "-apple-system, BlinkMacSystemFont, \"Segoe UI\", system-ui, sans-serif"
    private const val MONO_FALLBACK = "\"JetBrains Mono\", Menlo, Consolas, monospace"

    // VS Code's default chart colors. The IDE has no matching palette.
    private val DARK_CHARTS = linkedMapOf(
        "blue" to "#3794ff", "green" to "#89d185", "orange" to "#d18616",
        "purple" to "#b180d7", "red" to "#f14c4c", "yellow" to "#cca700",
    )
    private val LIGHT_CHARTS = linkedMapOf(
        "blue" to "#1a85ff", "green" to "#388a34", "orange" to "#d18616",
        "purple" to "#652d90", "red" to "#e51400", "yellow" to "#bf8803",
    )
}
