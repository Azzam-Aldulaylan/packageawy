package io.github.azzamaldulaylan.packageawy.webview

import com.intellij.openapi.editor.colors.EditorColorsManager
import com.intellij.ui.ColorUtil
import com.intellij.ui.JBColor
import com.intellij.util.ui.JBUI
import com.intellij.util.ui.NamedColorUtil
import com.intellij.util.ui.UIUtil
import java.awt.Color
import javax.swing.UIManager

/** Reads the current look and feel into a [Palette]. Call on the EDT. */
object IdeTheme {

    fun palette(): Palette {
        val dark = !JBColor.isBright()
        val background = JBUI.CurrentTheme.ToolWindow.background()
        val foreground = UIUtil.getLabelForeground()
        val scheme = EditorColorsManager.getInstance().globalScheme
        val font = UIUtil.getLabelFont()
        val buttonBackground = JBUI.CurrentTheme.Button.defaultButtonColorStart()
        val error = NamedColorUtil.getErrorForeground()
        val warning = color("Label.warningForeground", if (dark) Color(0xE0A84B) else Color(0x9E6A03))
        val info = JBUI.CurrentTheme.Link.Foreground.ENABLED
        return Palette(
            dark = dark,
            background = background,
            foreground = foreground,
            secondaryForeground = NamedColorUtil.getInactiveTextColor(),
            border = JBColor.border(),
            focus = JBUI.CurrentTheme.Focus.focusColor(),
            hoverBackground = JBUI.CurrentTheme.ActionButton.hoverBackground(),
            selectionBackground = JBUI.CurrentTheme.List.Selection.background(false),
            popupBackground = JBUI.CurrentTheme.Popup.BACKGROUND,
            inputBackground = UIUtil.getTextFieldBackground(),
            inputForeground = UIUtil.getTextFieldForeground(),
            inputBorder = color("Component.borderColor", JBColor.border()),
            placeholder = NamedColorUtil.getInactiveTextColor(),
            buttonBackground = buttonBackground,
            buttonForeground = color("Button.default.foreground", Color.WHITE),
            buttonBorder = color("Button.default.borderColor", buttonBackground),
            link = JBUI.CurrentTheme.Link.Foreground.ENABLED,
            linkHover = JBUI.CurrentTheme.Link.Foreground.HOVERED,
            error = error,
            errorBackground = JBUI.CurrentTheme.Validator.errorBackgroundColor(),
            errorBorder = JBUI.CurrentTheme.Validator.errorBorderColor(),
            warning = warning,
            warningBackground = JBUI.CurrentTheme.Validator.warningBackgroundColor(),
            warningBorder = JBUI.CurrentTheme.Validator.warningBorderColor(),
            info = info,
            infoBackground = JBUI.CurrentTheme.Banner.INFO_BACKGROUND,
            infoBorder = JBUI.CurrentTheme.Banner.INFO_BORDER_COLOR,
            codeBackground = ColorUtil.mix(background, scheme.defaultBackground, 0.5),
            fontFamily = font.family,
            fontSizePx = font.size,
            editorFontFamily = scheme.editorFontName,
        )
    }

    private fun color(key: String, fallback: Color): Color = UIManager.getColor(key) ?: fallback
}
